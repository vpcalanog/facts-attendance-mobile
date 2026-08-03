import * as SQLite from "expo-sqlite";

export interface AttendanceRow {
  id: string;
  studentNumber: string;
  eventId: string | null;
  timestamp: string;
  loggedBy: string | null;
  synced?: number;
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

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("facts_attendance.db");
  }
  return dbPromise;
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

export async function initDb(): Promise<SQLite.SQLiteDatabase> {
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
  `);

  // Safety net for installs that had the DB before `event_id` existed —
  // CREATE TABLE IF NOT EXISTS above is a no-op on those, so add the
  // column explicitly when it's missing rather than requiring a fresh install.
  // This MUST run before the index below: indexing a column that doesn't
  // exist yet on a pre-existing (un-migrated) install throws and aborts
  // the whole init, which is what silently skipped creating `events` too.
  await ensureColumn(db, "attendance", "event_id", "event_id TEXT");

  await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance (event_id);`);

  return db;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
  if (!entries || !entries.length) return;
  const db = await getDb();
  await db.execAsync("BEGIN");
  try {
    for (const e of entries) {
      await db.runAsync(
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
    await db.execAsync("COMMIT");
  } catch (err) {
    await db.execAsync("ROLLBACK");
    throw err;
  }
}

export async function markSynced(ids: string[]): Promise<void> {
  if (!ids || !ids.length) return;
  const db = await getDb();
  const placeholders = ids.map(() => "?").join(",");
  await db.runAsync(`UPDATE attendance SET synced = 1 WHERE id IN (${placeholders})`, ids);
}

export async function getPendingEntries(limit = 200): Promise<AttendanceRow[]> {
  const db = await getDb();
  return db.getAllAsync<AttendanceRow>(
    `SELECT id, student_number as studentNumber, event_id as eventId, timestamp, logged_by as loggedBy
     FROM attendance WHERE synced = 0 ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
}

export async function getPendingCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM attendance WHERE synced = 0`);
  return row ? row.count : 0;
}

export async function getAllEntries({
  search,
  eventId,
}: { search?: string; eventId?: string } = {}): Promise<AttendanceRow[]> {
  const db = await getDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (eventId) {
    clauses.push("event_id = ?");
    params.push(eventId);
  }
  if (search) {
    clauses.push("student_number LIKE ?");
    params.push(`%${search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.getAllAsync<AttendanceRow>(
    `SELECT id, student_number as studentNumber, event_id as eventId, timestamp, logged_by as loggedBy, synced
     FROM attendance ${where} ORDER BY timestamp DESC`,
    params
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

export async function replaceRoster(students: RosterRow[]): Promise<void> {
  const db = await getDb();
  await db.execAsync("BEGIN");
  try {
    await db.runAsync(`DELETE FROM roster`);
    const now = new Date().toISOString();
    for (const s of students) {
      await db.runAsync(
        `INSERT OR REPLACE INTO roster (student_number, name, course, year_level, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [s.studentNumber, s.name || "", s.course || "", s.yearLevel || "", now]
      );
    }
    await db.execAsync("COMMIT");
  } catch (err) {
    await db.execAsync("ROLLBACK");
    throw err;
  }
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

function safeParseArray(raw: any): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
  const id = genId();
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
    `SELECT id, name, description, starts_at as startsAt, courses, year_levels as yearLevels,
            created_by as createdBy, synced, updated_at as updatedAt
     FROM events WHERE synced = 0 ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
  return rows.map(parseEventRow);
}

async function upsertEventRow(db: SQLite.SQLiteDatabase, e: RemoteEvent, synced: number): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
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

// Replaces temp local rows with the server-assigned versions once a push
// is accepted. Rejected events are simply left as-is (still synced = 0)
// so the next sync pass retries them.
export async function applyEventSyncResult(
  accepted: { tempId: string; event: RemoteEvent }[]
): Promise<void> {
  if (!accepted.length) return;
  const db = await getDb();
  await db.execAsync("BEGIN");
  try {
    for (const { tempId, event } of accepted) {
      await db.runAsync(`DELETE FROM events WHERE id = ?`, [tempId]);
      await upsertEventRow(db, event, 1);
    }
    await db.execAsync("COMMIT");
  } catch (err) {
    await db.execAsync("ROLLBACK");
    throw err;
  }
}

// Upserts events pulled FROM the server — server is the source of truth
// for events, so these always win over any local synced=1 copy.
export async function upsertRemoteEvents(events: RemoteEvent[]): Promise<void> {
  if (!events || !events.length) return;
  const db = await getDb();
  await db.execAsync("BEGIN");
  try {
    for (const e of events) {
      await upsertEventRow(db, e, 1);
    }
    await db.execAsync("COMMIT");
  } catch (err) {
    await db.execAsync("ROLLBACK");
    throw err;
  }
}

export async function getEvents(): Promise<EventRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<any>(
    `SELECT id, name, description, starts_at as startsAt, courses, year_levels as yearLevels,
            created_by as createdBy, synced, updated_at as updatedAt
     FROM events ORDER BY COALESCE(starts_at, created_at) DESC`
  );
  return rows.map(parseEventRow);
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<any>(
    `SELECT id, name, description, starts_at as startsAt, courses, year_levels as yearLevels,
            created_by as createdBy, synced, updated_at as updatedAt
     FROM events WHERE id = ?`,
    [id]
  );
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
  const row = await db.getFirstAsync<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]);
  return row ? row.value : null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, [key, value]);
}
