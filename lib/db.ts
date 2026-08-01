import * as SQLite from "expo-sqlite";

export interface AttendanceRow {
  id: string;
  studentNumber: string;
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
  timestamp: string;
  loggedBy?: string | null;
  source?: string;
  receivedAt?: string;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("facts_attendance.db");
  }
  return dbPromise;
}

export async function initDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY NOT NULL,
      student_number TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );
  `);
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
  timestamp,
  loggedBy,
}: {
  studentNumber: string;
  timestamp?: string;
  loggedBy?: string | null;
}): Promise<AttendanceRow> {
  const db = await getDb();
  const id = genId();
  const createdAt = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO attendance (id, student_number, timestamp, logged_by, source, synced, created_at)
     VALUES (?, ?, ?, ?, 'mobile', 0, ?)`,
    [id, studentNumber, timestamp || createdAt, loggedBy || null, createdAt]
  );
  return { id, studentNumber, timestamp: timestamp || createdAt, loggedBy: loggedBy || null, synced: 0 };
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
        `INSERT OR IGNORE INTO attendance (id, student_number, timestamp, logged_by, source, synced, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [e.id, e.studentNumber, e.timestamp, e.loggedBy || null, e.source || "server", e.receivedAt || e.timestamp]
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
    `SELECT id, student_number as studentNumber, timestamp, logged_by as loggedBy
     FROM attendance WHERE synced = 0 ORDER BY created_at ASC LIMIT ?`,
    [limit]
  );
}

export async function getPendingCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM attendance WHERE synced = 0`);
  return row ? row.count : 0;
}

export async function getAllEntries({ search }: { search?: string } = {}): Promise<AttendanceRow[]> {
  const db = await getDb();
  if (search) {
    return db.getAllAsync<AttendanceRow>(
      `SELECT id, student_number as studentNumber, timestamp, logged_by as loggedBy, synced
       FROM attendance WHERE student_number LIKE ? ORDER BY timestamp DESC`,
      [`%${search}%`]
    );
  }
  return db.getAllAsync<AttendanceRow>(
    `SELECT id, student_number as studentNumber, timestamp, logged_by as loggedBy, synced
     FROM attendance ORDER BY timestamp DESC`
  );
}

export async function findRecentDuplicate(
  studentNumber: string,
  windowMs: number
): Promise<{ id: string; timestamp: string } | null> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const row = await db.getFirstAsync<{ id: string; timestamp: string }>(
    `SELECT id, timestamp FROM attendance
     WHERE student_number = ? AND timestamp >= ?
     ORDER BY timestamp DESC LIMIT 1`,
    [studentNumber, cutoff]
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
