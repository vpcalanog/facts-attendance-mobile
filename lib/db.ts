import * as SQLite from "expo-sqlite";
import { log } from "./logger";

export interface AttendanceRow {
  id: string;
  studentNumber: string;
  eventId: string | null;
  timestamp: string;
  loggedBy: string | null;
  synced?: number;
  attempts?: number;
  lastError?: string | null;
  dead?: number;
}

/** An attendance row joined with its roster entry, if any. */
export interface AttendanceWithStudent extends AttendanceRow {
  studentName: string | null;
  studentCourse: string | null;
  studentYearLevel: string | null;
}

export interface RosterRow {
  studentNumber: string;
  name: string;
  course: string;
  yearLevel: string;
}

export interface RemoteEntry {
  id: string;
  studentNumber: string;
  eventId?: string | null;
  timestamp: string;
  loggedBy?: string | null;
  source?: string;
  receivedAt?: string;
}

export interface EventRow {
  id: string;
  name: string;
  description: string | null;
  startsAt: string | null;
  courses: string[];
  yearLevels: string[];
  createdBy: string | null;
  synced?: number;
  updatedAt?: string | null;
}

// Shape of an event as it comes from / goes to the server. `courses` and
// `yearLevels` travel as real arrays over the wire; we only serialize them
// to JSON text for local SQLite storage.
export interface RemoteEvent {
  id: string;
  name: string;
  description?: string | null;
  startsAt?: string | null;
  courses?: string[];
  yearLevels?: string[];
  createdBy?: string | null;
  updatedAt?: string | null;
}

/** After this many failed push attempts an entry stops being retried
 *  automatically and is surfaced to the user instead, so one poisoned row
 *  can't keep the queue churning forever. */
export const MAX_PUSH_ATTEMPTS = 5;

const DEVICE_ID_KEY = "device_id";
const SCHEMA_VERSION = 2;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("facts_attendance.db");
  }
  return dbPromise;
}

/**
 * Every multi-statement write goes through here.
 *
 * The previous code issued BEGIN / COMMIT / ROLLBACK by hand via
 * execAsync. expo-sqlite documents that anything running while such a
 * transaction is open — including queries started elsewhere in the app —
 * is swept into it. So a roster refresh that failed halfway would roll
 * back an attendance insert a staff member made at the same moment, and
 * two overlapping writers produced "cannot start a transaction within a
 * transaction". withExclusiveTransactionAsync scopes the transaction to
 * its own connection, which is the only safe primitive here.
 */
async function tx(fn: (t: SQLite.SQLiteDatabase) => Promise<void>): Promise<void> {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(fn);
}

async function ensureColumn(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  ddl: string
): Promise<void> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function initDb(): Promise<SQLite.SQLiteDatabase> {
  // Memoized: the provider mounts once, but a fast remount (or a second
  // provider during a hot reload) would otherwise run migrations twice
  // concurrently and race on ALTER TABLE.
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<SQLite.SQLiteDatabase> {
  const db = await getDb();

  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY NOT NULL,
      student_number TEXT NOT NULL,
      event_id TEXT,
      timestamp TEXT NOT NULL,
      logged_by TEXT,
      source TEXT DEFAULT 'mobile',
      synced INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance (student_number);
    CREATE INDEX IF NOT EXISTS idx_attendance_synced ON attendance (synced);

    CREATE TABLE IF NOT EXISTS roster (
      student_number TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      course TEXT,
      year_level TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      starts_at TEXT,
      courses TEXT NOT NULL DEFAULT '[]',
      year_levels TEXT NOT NULL DEFAULT '[]',
      created_by TEXT,
      synced INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_synced ON events (synced);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS event_id_map (
      temp_id TEXT PRIMARY KEY NOT NULL,
      real_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Safety net for installs that predate these columns — CREATE TABLE IF
  // NOT EXISTS is a no-op there, so add them explicitly rather than
  // requiring a fresh install. These MUST run before the indexes below:
  // indexing a column that doesn't exist yet throws and aborts init.
  await ensureColumn(db, "attendance", "event_id", "event_id TEXT");
  await ensureColumn(db, "attendance", "attempts", "attempts INTEGER NOT NULL DEFAULT 0");
  await ensureColumn(db, "attendance", "last_error", "last_error TEXT");
  await ensureColumn(db, "attendance", "dead", "dead INTEGER NOT NULL DEFAULT 0");

  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance (event_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_queue ON attendance (synced, dead, created_at);
    CREATE INDEX IF NOT EXISTS idx_attendance_ts ON attendance (timestamp);
  `);

  await db.runAsync(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`, [
    String(SCHEMA_VERSION),
  ]);

  await loadDeviceId(db);
  return db;
}

// --- id generation ----------------------------------------------------

let deviceId: string | null = null;
let idCounter = 0;

function randomChunk(): string {
  return Math.random().toString(36).slice(2).padEnd(8, "0").slice(0, 8);
}

/**
 * A stable random prefix per install, persisted alongside the data.
 *
 * Row ids double as the server's idempotency key: a push whose response is
 * lost gets replayed with the same ids, and the server upserts. That only
 * holds if ids are genuinely unique. The old generator was
 * `Date.now() + 6 random base-36 chars`, which two devices scanning in the
 * same millisecond can collide on — and a collision means one device's
 * scan silently overwrites another's on the server.
 */
async function loadDeviceId(db: SQLite.SQLiteDatabase): Promise<string> {
  if (deviceId) return deviceId;
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
    DEVICE_ID_KEY,
  ]);
  if (row?.value) {
    deviceId = row.value;
    return deviceId;
  }
  const generated = `${randomChunk()}${randomChunk()}`;
  await db.runAsync(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [
    DEVICE_ID_KEY,
    generated,
  ]);
  deviceId = generated;
  return generated;
}

function genId(): string {
  // deviceId is loaded during initDb, which every write path is gated
  // behind; the fallback only matters in tests that skip init.
  const prefix = deviceId ?? "nodevice";
  idCounter += 1;
  return `${Date.now().toString(36)}-${prefix}-${idCounter.toString(36)}`;
}

/** Temp ids carry a marker so "is this event still local-only?" never
 *  depends on reading a `synced` flag from a row that may already be gone. */
function genTempEventId(): string {
  return `tmp_${genId()}`;
}

export function isTempEventId(id: string): boolean {
  return typeof id === "string" && id.startsWith("tmp_");
}

// --- attendance -----------------------------------------------------

// Always writes locally first — this is the offline-first contract. The
// sync layer picks up unsynced rows later; callers never have to know or
// care whether the network is up.
export async function insertAttendance({
  studentNumber,
  eventId,
  timestamp,
  loggedBy,
}: {
  studentNumber: string;
  eventId: string;
  timestamp?: string;
  loggedBy?: string | null;
}): Promise<AttendanceRow> {
  const db = await getDb();
  const id = genId();
  const createdAt = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO attendance (id, student_number, event_id, timestamp, logged_by, source, synced, created_at)
     VALUES (?, ?, ?, ?, ?, 'mobile', 0, ?)`,
    [id, studentNumber, eventId, timestamp || createdAt, loggedBy || null, createdAt]
  );
  return {
    id,
    studentNumber,
    eventId,
    timestamp: timestamp || createdAt,
    loggedBy: loggedBy || null,
    synced: 0,
  };
}

// Upserts entries that came FROM the server (already synced there), e.g.
// entries logged by another device. INSERT OR IGNORE means a device's own
// not-yet-synced local writes are never clobbered by this.
export async function upsertRemoteEntries(entries: RemoteEntry[]): Promise<void> {
  if (!Array.isArray(entries) || !entries.length) return;
  await tx(async (t) => {
    for (const e of entries) {
      if (!e?.id || !e?.studentNumber || !e?.timestamp) continue;
      await t.runAsync(
        `INSERT OR IGNORE INTO attendance (id, student_number, event_id, timestamp, logged_by, source, synced, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          e.id,
          e.studentNumber,
          e.eventId || null,
          e.timestamp,
          e.loggedBy || null,
          e.source || "server",
          e.receivedAt || e.timestamp,
        ]
      );
    }
  });
}

export async function markSynced(ids: string[]): Promise<void> {
  if (!ids || !ids.length) return;
  const db = await getDb();
  // SQLite's default host-parameter limit is 999; chunk so a large drain
  // can never blow past it.
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => "?").join(",");
    await db.runAsync(
      `UPDATE attendance SET synced = 1, dead = 0, last_error = NULL WHERE id IN (${placeholders})`,
      chunk
    );
  }
}

/**
 * Records that the server refused these rows. Attempts are counted so a
 * permanently invalid entry (bad event, failed validation) eventually
 * stops being retried and gets surfaced to the user, instead of sitting in
 * the queue forever making the pending badge lie.
 */
export async function markPushFailed(ids: string[], reason: string): Promise<void> {
  if (!ids || !ids.length) return;
  await tx(async (t) => {
    for (const id of ids) {
      await t.runAsync(
        `UPDATE attendance
            SET attempts = attempts + 1,
                last_error = ?,
                dead = CASE WHEN attempts + 1 >= ? THEN 1 ELSE 0 END
          WHERE id = ? AND synced = 0`,
        [reason.slice(0, 300), MAX_PUSH_ATTEMPTS, id]
      );
    }
  });
}

/** Puts dead-lettered rows back in the queue — exposed on the profile
 *  screen so a staff member can retry once the cause is fixed. */
export async function revivePushFailures(): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    `UPDATE attendance SET dead = 0, attempts = 0, last_error = NULL WHERE synced = 0 AND dead = 1`
  );
  return res.changes ?? 0;
}

/**
 * Rows ready to upload. Scans against an event that hasn't reached the
 * server yet are held back: the server can only refuse an event id it has
 * never seen, and five refusals used to dead-letter the scans before the
 * event push had a chance to succeed. applyEventSyncResult re-points them
 * to the real id, which releases them here.
 */
export async function getPendingEntries(limit = 200): Promise<AttendanceRow[]> {
  const db = await getDb();
  return db.getAllAsync<AttendanceRow>(
    `SELECT id, student_number as studentNumber, event_id as eventId, timestamp, logged_by as loggedBy
     FROM attendance
     WHERE synced = 0 AND dead = 0 AND (event_id IS NULL OR event_id NOT LIKE 'tmp\\_%' ESCAPE '\\')
     ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
}

export async function getPendingCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM attendance WHERE synced = 0 AND dead = 0`
  );
  return row ? row.count : 0;
}

export async function getFailedCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM attendance WHERE synced = 0 AND dead = 1`
  );
  return row ? row.count : 0;
}

/**
 * Attendance joined against the roster in one query.
 *
 * The logs screen used to fire one findStudent() per unique student number
 * after every keystroke — several hundred concurrent SQLite reads on a
 * busy event. This is the same data in a single statement.
 */
export async function getEntriesWithStudents({
  search,
  eventId,
  limit = 100,
  offset = 0,
}: {
  search?: string;
  eventId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<AttendanceWithStudent[]> {
  const db = await getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (eventId) {
    clauses.push("a.event_id = ?");
    params.push(eventId);
  }
  if (search) {
    clauses.push("(a.student_number LIKE ? OR UPPER(r.name) LIKE ?)");
    params.push(`%${search}%`, `%${search.toUpperCase()}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit, offset);
  return db.getAllAsync<AttendanceWithStudent>(
    `SELECT a.id, a.student_number as studentNumber, a.event_id as eventId, a.timestamp,
            a.logged_by as loggedBy, a.synced, a.dead, a.last_error as lastError,
            r.name as studentName, r.course as studentCourse, r.year_level as studentYearLevel
     FROM attendance a
     LEFT JOIN roster r ON r.student_number = a.student_number
     ${where}
     ORDER BY a.timestamp DESC
     LIMIT ? OFFSET ?`,
    params
  );
}

/** Total matching rows, for end-of-list detection and the header count. */
export async function countEntries({
  search,
  eventId,
}: { search?: string; eventId?: string } = {}): Promise<number> {
  const db = await getDb();
  const clauses: string[] = [];
  const params: string[] = [];
  if (eventId) {
    clauses.push("a.event_id = ?");
    params.push(eventId);
  }
  if (search) {
    clauses.push("(a.student_number LIKE ? OR UPPER(r.name) LIKE ?)");
    params.push(`%${search}%`, `%${search.toUpperCase()}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM attendance a
     LEFT JOIN roster r ON r.student_number = a.student_number ${where}`,
    params
  );
  return row ? row.count : 0;
}

/** Entries logged today for one event — computed in SQL so the count stays
 *  correct no matter how many rows the list has paged in. */
export async function countEntriesToday(eventId: string): Promise<number> {
  const db = await getDb();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM attendance WHERE event_id = ? AND timestamp >= ?`,
    [eventId, start.toISOString()]
  );
  return row ? row.count : 0;
}

/** Every entry for one event, oldest first — used by the CSV export, which
 *  must cover the whole event rather than the page currently on screen. */
export async function getAllEntriesForExport(eventId: string): Promise<AttendanceWithStudent[]> {
  const db = await getDb();
  return db.getAllAsync<AttendanceWithStudent>(
    `SELECT a.id, a.student_number as studentNumber, a.event_id as eventId, a.timestamp,
            a.logged_by as loggedBy, a.synced, a.dead, a.last_error as lastError,
            r.name as studentName, r.course as studentCourse, r.year_level as studentYearLevel
     FROM attendance a
     LEFT JOIN roster r ON r.student_number = a.student_number
     WHERE a.event_id = ?
     ORDER BY a.timestamp ASC`,
    [eventId]
  );
}

// Duplicate detection is scoped per event — the same student can
// legitimately be logged at two different events within the same window.
export async function findRecentDuplicate(
  studentNumber: string,
  windowMs: number,
  eventId: string
): Promise<{ id: string; timestamp: string } | null> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = await db.getFirstAsync<{ id: string; timestamp: string }>(
    `SELECT id, timestamp FROM attendance
     WHERE student_number = ? AND event_id = ? AND timestamp >= ?
     ORDER BY timestamp DESC LIMIT 1`,
    [studentNumber, eventId, cutoff]
  );
  return row || null;
}

// --- roster -----------------------------------------------------------

export async function getRosterCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM roster`);
  return row ? row.count : 0;
}

/**
 * Replaces the roster wholesale.
 *
 * Refuses to replace a populated roster with an empty payload: a server
 * hiccup answering with no students would otherwise wipe the local copy,
 * and the 15-minute refresh throttle then kept it wiped — every student
 * showing as "Not in roster" for the rest of the event, offline, with no
 * way to recover.
 */
export async function replaceRoster(
  students: RosterRow[]
): Promise<{ replaced: boolean; count: number }> {
  if (!Array.isArray(students)) {
    log.warn("roster payload was not an array; keeping existing roster");
    return { replaced: false, count: await getRosterCount() };
  }
  if (students.length === 0) {
    const existing = await getRosterCount();
    if (existing > 0) {
      log.warn("refusing to replace a populated roster with an empty payload", { existing });
      return { replaced: false, count: existing };
    }
  }

  const valid = students.filter(
    (s): s is RosterRow => !!s && typeof s.studentNumber === "string" && !!s.studentNumber
  );

  await tx(async (t) => {
    await t.runAsync(`DELETE FROM roster`);
    const now = new Date().toISOString();
    for (const s of valid) {
      await t.runAsync(
        `INSERT OR REPLACE INTO roster (student_number, name, course, year_level, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [s.studentNumber, s.name || "", s.course || "", s.yearLevel || "", now]
      );
    }
  });
  return { replaced: true, count: valid.length };
}

export async function findStudent(studentNumber: string): Promise<RosterRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<RosterRow>(
    `SELECT student_number as studentNumber, name, course, year_level as yearLevel
     FROM roster WHERE student_number = ?`,
    [studentNumber]
  );
  return row || null;
}

// Distinct course/year-level values present in the roster, used to build
// the picker when an admin scopes an event to specific groups.
export async function getRosterFacets(): Promise<{ courses: string[]; yearLevels: string[] }> {
  const db = await getDb();
  const courseRows = await db.getAllAsync<{ course: string }>(
    `SELECT DISTINCT course FROM roster WHERE course IS NOT NULL AND course != '' ORDER BY course ASC`
  );
  const yearRows = await db.getAllAsync<{ year_level: string }>(
    `SELECT DISTINCT year_level FROM roster WHERE year_level IS NOT NULL AND year_level != '' ORDER BY year_level ASC`
  );
  return {
    courses: courseRows.map((r) => r.course),
    yearLevels: yearRows.map((r) => r.year_level),
  };
}

// --- events -------------------------------------------------------------

function safeParseArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseEventRow(row: any): EventRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    startsAt: row.startsAt || null,
    courses: safeParseArray(row.courses),
    yearLevels: safeParseArray(row.yearLevels),
    createdBy: row.createdBy || null,
    synced: row.synced,
    updatedAt: row.updatedAt || null,
  };
}

const EVENT_COLUMNS = `id, name, description, starts_at as startsAt, courses, year_levels as yearLevels,
                       created_by as createdBy, synced, updated_at as updatedAt`;

// Creates an event locally (synced = 0) so admins can create events
// offline; the sync layer pushes it to the server and reconciles the
// real server-assigned id the next time it runs.
export async function createEventLocal({
  name,
  description,
  startsAt,
  courses,
  yearLevels,
  createdBy,
}: {
  name: string;
  description?: string | null;
  startsAt?: string | null;
  courses: string[];
  yearLevels: string[];
  createdBy: string | null;
}): Promise<EventRow> {
  const db = await getDb();
  const id = genTempEventId();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO events (id, name, description, starts_at, courses, year_levels, created_by, synced, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      name,
      description || null,
      startsAt || null,
      JSON.stringify(courses),
      JSON.stringify(yearLevels),
      createdBy,
      now,
      now,
    ]
  );
  return {
    id,
    name,
    description: description || null,
    startsAt: startsAt || null,
    courses,
    yearLevels,
    createdBy,
    synced: 0,
    updatedAt: now,
  };
}

export async function getPendingEvents(limit = 50): Promise<EventRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE synced = 0 ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
  return rows.map(parseEventRow);
}

async function upsertEventRow(
  t: SQLite.SQLiteDatabase,
  e: RemoteEvent,
  synced: number
): Promise<void> {
  const now = new Date().toISOString();
  await t.runAsync(
    `INSERT OR REPLACE INTO events (id, name, description, starts_at, courses, year_levels, created_by, synced, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM events WHERE id = ?), ?))`,
    [
      e.id,
      e.name,
      e.description || null,
      e.startsAt || null,
      JSON.stringify(e.courses || []),
      JSON.stringify(e.yearLevels || []),
      e.createdBy || null,
      synced,
      e.updatedAt || now,
      e.id,
      now,
    ]
  );
}

/**
 * Replaces temp local rows with the server-assigned versions once a push
 * is accepted.
 *
 * Critically, this also re-points every attendance row that was logged
 * against the temporary id. Without that step the old code deleted the
 * temp event and left its scans orphaned: invisible in the logs screen
 * (which filters by event id), attached to an event id the server has
 * never heard of, and therefore rejected on every subsequent push — a
 * silent loss of exactly the data the app exists to collect.
 *
 * Rejected events are left as-is (still synced = 0) so the next pass
 * retries them.
 */
export async function applyEventSyncResult(
  accepted: { tempId: string; event: RemoteEvent }[]
): Promise<void> {
  if (!accepted.length) return;
  const now = new Date().toISOString();
  await tx(async (t) => {
    for (const { tempId, event } of accepted) {
      if (!tempId || !event?.id) continue;
      await upsertEventRow(t, event, 1);
      if (tempId !== event.id) {
        // Also revives any that were dead-lettered for pointing at the
        // temp id, from before such rows were held back from the push.
        await t.runAsync(
          `UPDATE attendance
              SET event_id = ?,
                  dead = CASE WHEN synced = 0 THEN 0 ELSE dead END,
                  attempts = CASE WHEN synced = 0 THEN 0 ELSE attempts END
            WHERE event_id = ?`,
          [event.id, tempId]
        );
        await t.runAsync(`DELETE FROM events WHERE id = ?`, [tempId]);
        await t.runAsync(
          `INSERT OR REPLACE INTO event_id_map (temp_id, real_id, created_at) VALUES (?, ?, ?)`,
          [tempId, event.id, now]
        );
      }
    }
  });
  log.info("reconciled locally-created events", { count: accepted.length });
}

/**
 * Follows a temp id to the server id it became, so a screen whose route
 * param was captured before a sync keeps working instead of rendering an
 * empty event.
 */
export async function resolveEventId(id: string): Promise<string> {
  if (!id || !isTempEventId(id)) return id;
  const db = await getDb();
  const row = await db.getFirstAsync<{ real_id: string }>(
    `SELECT real_id FROM event_id_map WHERE temp_id = ?`,
    [id]
  );
  return row?.real_id || id;
}

// Upserts events pulled FROM the server — server is the source of truth
// for events, so these always win over any local synced=1 copy.
export async function upsertRemoteEvents(events: RemoteEvent[]): Promise<void> {
  if (!Array.isArray(events) || !events.length) return;
  await tx(async (t) => {
    for (const e of events) {
      if (!e?.id || typeof e.name !== "string") continue;
      await upsertEventRow(t, e, 1);
    }
  });
}

/**
 * Drops events the server no longer lists, so a deletion made on the web
 * admin eventually reaches the device instead of lingering forever.
 *
 * Deliberately conservative: only previously-synced events with no local
 * attendance are removed. Pruning an event that still has scans attached
 * would orphan them, and locally-created events that haven't been pushed
 * yet are obviously not expected to appear in the server's list.
 */
export async function pruneMissingEvents(serverIds: string[]): Promise<number> {
  if (!Array.isArray(serverIds)) return 0;
  // Guard against blowing past SQLite's host-parameter limit; with that
  // many events, skipping a prune pass is the safer failure.
  if (serverIds.length > 800) return 0;
  const db = await getDb();
  // `id NOT IN (NULL)` evaluates to NULL rather than true in SQL, so the
  // empty case needs its own statement — otherwise "the server has no
  // events left" would silently prune nothing.
  const notInServerList = serverIds.length
    ? `AND id NOT IN (${serverIds.map(() => "?").join(",")})`
    : "";
  const res = await db.runAsync(
    `DELETE FROM events
      WHERE synced = 1
        ${notInServerList}
        AND NOT EXISTS (SELECT 1 FROM attendance WHERE attendance.event_id = events.id)`,
    serverIds
  );
  const removed = res.changes ?? 0;
  if (removed) log.info("pruned events deleted on the server", { removed });
  return removed;
}

export async function getEvents(): Promise<EventRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT ${EVENT_COLUMNS} FROM events ORDER BY COALESCE(starts_at, created_at) DESC`
  );
  return rows.map(parseEventRow);
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const db = await getDb();
  const resolved = await resolveEventId(id);
  const row = await db.getFirstAsync<any>(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`, [
    resolved,
  ]);
  return row ? parseEventRow(row) : null;
}

// An event with no courses/yearLevels set applies to everyone. Returns
// null when the student is eligible, or a short message to surface as a
// non-blocking warning otherwise. Students not found in the roster are
// handled separately by the existing "not in roster" state.
export function checkEventEligibility(event: EventRow, student: RosterRow | null): string | null {
  if (!student) return null;
  if (event.courses.length && !event.courses.includes(student.course)) {
    return `${student.course || "This student"} isn't in ${event.name}'s course list.`;
  }
  if (event.yearLevels.length && !event.yearLevels.includes(student.yearLevel)) {
    return `${student.yearLevel || "This student"} isn't in ${event.name}'s year level list.`;
  }
  return null;
}

// --- meta ---------------------------------------------------------------

export async function getMeta(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
    key,
  ]);
  return row ? row.value : null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  if (typeof value !== "string") {
    // SQLite rejects undefined bindings outright, which used to surface as
    // an opaque "Sync failed." whenever the server omitted `serverTime`.
    log.warn("ignoring non-string meta write", { key });
    return;
  }
  const db = await getDb();
  await db.runAsync(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value]);
}

// --- account isolation --------------------------------------------------

/**
 * Wipes every cached server-owned record on this device.
 *
 * Called when a *different* staff member signs in. Nothing here is scoped
 * per user, so without this the next person inherits the previous one's
 * roster, events, attendance logs and — worst of all — their unsynced
 * queue, which would then be pushed to the server under the new person's
 * token.
 *
 * The device id and schema version survive, so replayed ids stay unique.
 */
export async function resetLocalData(): Promise<void> {
  await tx(async (t) => {
    await t.runAsync(`DELETE FROM attendance`);
    await t.runAsync(`DELETE FROM roster`);
    await t.runAsync(`DELETE FROM events`);
    await t.runAsync(`DELETE FROM event_id_map`);
    await t.runAsync(`DELETE FROM meta WHERE key NOT IN (?, 'schema_version')`, [DEVICE_ID_KEY]);
  });
  log.info("cleared local data for account switch");
}
