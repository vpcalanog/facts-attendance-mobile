/**
 * These exercise lib/db.ts against a real SQLite engine — Node's built-in
 * `node:sqlite` standing in for expo-sqlite — so the statements under
 * test are the same ones that run on a device. Mocking the query results
 * instead would have proved nothing about the SQL, and the SQL is where
 * the data-loss bugs were.
 */
jest.mock("expo-sqlite", () => require("./sqlite-mock").createExpoSqliteMock());

type Db = typeof import("@/lib/db");

let db: Db;

beforeEach(async () => {
  // Fresh module state gives each test a brand-new in-memory database,
  // since lib/db memoizes its connection.
  jest.resetModules();
  db = require("@/lib/db");
  await db.initDb();
});

const EVENT_INPUT = {
  name: "Orientation",
  courses: [] as string[],
  yearLevels: [] as string[],
  createdBy: "amabini",
};

describe("schema", () => {
  it("initializes and is safe to run twice", async () => {
    await expect(db.initDb()).resolves.toBeDefined();
    await expect(db.getPendingCount()).resolves.toBe(0);
  });
});

describe("attendance queue", () => {
  it("queues a scan locally and clears it once the server accepts it", async () => {
    const row = await db.insertAttendance({
      studentNumber: "S2012345678",
      eventId: "ev1",
      loggedBy: "amabini",
    });

    await expect(db.getPendingCount()).resolves.toBe(1);
    await db.markSynced([row.id]);
    await expect(db.getPendingCount()).resolves.toBe(0);
  });

  it("generates ids that don't collide within the same millisecond", async () => {
    // The old generator was Date.now() plus six random base-36 chars,
    // which two devices scanning together could duplicate — and a
    // duplicate id means one device's scan overwrites another's on the
    // server, because the id is the upsert key.
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const r = await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });
      ids.add(r.id);
    }
    expect(ids.size).toBe(200);
  });

  it("dead-letters an entry after repeated refusals and can revive it", async () => {
    const row = await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });

    for (let i = 0; i < db.MAX_PUSH_ATTEMPTS; i++) {
      await db.markPushFailed([row.id], "unknown event");
    }

    // It stops clogging the upload queue...
    await expect(db.getPendingEntries()).resolves.toHaveLength(0);
    await expect(db.getPendingCount()).resolves.toBe(0);
    // ...but is surfaced rather than silently dropped.
    await expect(db.getFailedCount()).resolves.toBe(1);

    await expect(db.revivePushFailures()).resolves.toBe(1);
    await expect(db.getPendingCount()).resolves.toBe(1);
    await expect(db.getFailedCount()).resolves.toBe(0);
  });

  it("does not let a server copy overwrite an unsynced local scan with the same id", async () => {
    const row = await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });

    await db.upsertRemoteEntries([
      {
        id: row.id,
        studentNumber: "S2099999999",
        eventId: "ev1",
        timestamp: new Date().toISOString(),
      },
    ]);

    const [stored] = await db.getEntriesWithStudents({ eventId: "ev1" });
    expect(stored.studentNumber).toBe("S2012345678");
    expect(stored.synced).toBe(0);
  });

  it("counts only today's entries for the event header", async () => {
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });
    await db.insertAttendance({
      studentNumber: "S2012345679",
      eventId: "ev1",
      timestamp: new Date(Date.now() - 3 * 86400_000).toISOString(),
    });

    await expect(db.countEntriesToday("ev1")).resolves.toBe(1);
    await expect(db.countEntries({ eventId: "ev1" })).resolves.toBe(2);
  });
});

describe("locally created events", () => {
  /**
   * The most damaging bug in the original code. An admin creating an
   * event offline scanned against a temporary id; reconciliation deleted
   * the temp event row and inserted the server's, leaving every scan
   * pointing at an event id that no longer existed anywhere — absent
   * from the logs screen, and rejected by the server forever.
   */
  it("re-points attendance when a temp event becomes a server event", async () => {
    const local = await db.createEventLocal(EVENT_INPUT);
    expect(db.isTempEventId(local.id)).toBe(true);

    const scan = await db.insertAttendance({
      studentNumber: "S2012345678",
      eventId: local.id,
      loggedBy: "amabini",
    });

    await db.applyEventSyncResult([
      { tempId: local.id, event: { id: "srv-77", name: "Orientation" } },
    ]);

    // The scan followed the event.
    const rows = await db.getEntriesWithStudents({ eventId: "srv-77" });
    expect(rows.map((r) => r.id)).toEqual([scan.id]);
    await expect(db.getEntriesWithStudents({ eventId: local.id })).resolves.toHaveLength(0);

    // The temp row is gone, the server row is present and marked synced.
    const events = await db.getEvents();
    expect(events.map((e) => e.id)).toEqual(["srv-77"]);
    expect(events[0].synced).toBe(1);

    // And a screen still holding the old id in its route params recovers.
    await expect(db.resolveEventId(local.id)).resolves.toBe("srv-77");
    await expect(db.getEvent(local.id)).resolves.toMatchObject({ id: "srv-77" });
  });

  /**
   * Pushing a scan whose event the server hasn't seen can only be
   * refused, and five refusals dead-lettered it — so a slow or failing
   * event push used to strand every scan taken at a new event.
   */
  it("holds scans back from the push until their event has a server id", async () => {
    const local = await db.createEventLocal(EVENT_INPUT);
    const scan = await db.insertAttendance({ studentNumber: "S2012345678", eventId: local.id });

    await expect(db.getPendingEntries()).resolves.toHaveLength(0);
    // Still counted as waiting, so the badge stays honest.
    await expect(db.getPendingCount()).resolves.toBe(1);

    await db.applyEventSyncResult([
      { tempId: local.id, event: { id: "srv-77", name: "Orientation" } },
    ]);
    const pending = await db.getPendingEntries();
    expect(pending.map((p) => [p.id, p.eventId])).toEqual([[scan.id, "srv-77"]]);
  });

  it("revives temp-event scans that were dead-lettered before reconciliation", async () => {
    const local = await db.createEventLocal(EVENT_INPUT);
    const scan = await db.insertAttendance({ studentNumber: "S2012345678", eventId: local.id });
    for (let i = 0; i < db.MAX_PUSH_ATTEMPTS; i++) {
      await db.markPushFailed([scan.id], "unknown event");
    }
    await expect(db.getFailedCount()).resolves.toBe(1);

    await db.applyEventSyncResult([
      { tempId: local.id, event: { id: "srv-77", name: "Orientation" } },
    ]);

    await expect(db.getFailedCount()).resolves.toBe(0);
    await expect(db.getPendingEntries()).resolves.toHaveLength(1);
  });

  it("logs a scan against the real id when the screen still holds the temp one", async () => {
    const { logAttendance } = require("@/lib/attendance") as typeof import("@/lib/attendance");
    const local = await db.createEventLocal(EVENT_INPUT);
    await db.applyEventSyncResult([
      { tempId: local.id, event: { id: "srv-77", name: "Orientation" } },
    ]);

    const result = await logAttendance({
      studentNumber: "S2012345678",
      eventId: local.id,
      officer: null,
      officerCohort: null,
    });

    expect(result).toMatchObject({ status: "logged", row: { eventId: "srv-77" } });
    await expect(db.getEntriesWithStudents({ eventId: "srv-77" })).resolves.toHaveLength(1);
  });

  it("keeps an unpushed event queued so the next pass retries it", async () => {
    const local = await db.createEventLocal(EVENT_INPUT);
    await db.applyEventSyncResult([]);

    const pending = await db.getPendingEvents();
    expect(pending.map((e) => e.id)).toEqual([local.id]);
  });

  it("round-trips course and year-level scoping through JSON storage", async () => {
    const local = await db.createEventLocal({
      ...EVENT_INPUT,
      courses: ["BSIT", "BSCS"],
      yearLevels: ["1st"],
    });
    const loaded = await db.getEvent(local.id);
    expect(loaded?.courses).toEqual(["BSIT", "BSCS"]);
    expect(loaded?.yearLevels).toEqual(["1st"]);
  });
});

describe("events pulled from the server", () => {
  it("keep the end time, so the list can show the event's window", async () => {
    await db.upsertRemoteEvents([
      {
        id: "ccit-fair-2026",
        name: "CCIT Fair",
        startsAt: "2026-09-24T08:00:00+08:00",
        endsAt: "2026-09-24T09:30:00+08:00",
      },
    ]);

    await expect(db.getEvent("ccit-fair-2026")).resolves.toMatchObject({
      startsAt: "2026-09-24T08:00:00+08:00",
      endsAt: "2026-09-24T09:30:00+08:00",
    });
  });
});

describe("pruning events deleted on the server", () => {
  it("removes a synced event the server no longer lists", async () => {
    await db.upsertRemoteEvents([
      { id: "ev1", name: "Kept" },
      { id: "ev2", name: "Deleted upstream" },
    ]);

    await expect(db.pruneMissingEvents(["ev1"])).resolves.toBe(1);
    expect((await db.getEvents()).map((e) => e.id)).toEqual(["ev1"]);
  });

  it("prunes correctly when the server has no events left at all", async () => {
    await db.upsertRemoteEvents([{ id: "ev1", name: "Deleted upstream" }]);

    // `id NOT IN (NULL)` is never true in SQL, so the empty-list case
    // needs its own statement or this silently prunes nothing.
    await expect(db.pruneMissingEvents([])).resolves.toBe(1);
    await expect(db.getEvents()).resolves.toHaveLength(0);
  });

  it("never prunes an event that still has scans attached", async () => {
    await db.upsertRemoteEvents([{ id: "ev2", name: "Has scans" }]);
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev2" });

    // Removing it would orphan the attendance, which is worse than
    // showing an event that no longer exists upstream.
    await expect(db.pruneMissingEvents([])).resolves.toBe(0);
    expect((await db.getEvents()).map((e) => e.id)).toEqual(["ev2"]);
  });

  it("never prunes an event that hasn't been pushed yet", async () => {
    const local = await db.createEventLocal(EVENT_INPUT);

    await expect(db.pruneMissingEvents([])).resolves.toBe(0);
    expect((await db.getEvents()).map((e) => e.id)).toEqual([local.id]);
  });
});

describe("roster", () => {
  const STUDENTS = [
    { studentNumber: "S2012345678", name: "Ana Reyes", course: "BSIT", yearLevel: "1st" },
    { studentNumber: "S2012345679", name: "Ben Cruz", course: "BSCS", yearLevel: "2nd" },
  ];

  it("replaces the roster wholesale", async () => {
    await expect(db.replaceRoster(STUDENTS)).resolves.toEqual({ replaced: true, count: 2 });
    await expect(db.getRosterCount()).resolves.toBe(2);
    await expect(db.findStudent("S2012345678")).resolves.toMatchObject({ name: "Ana Reyes" });
  });

  /**
   * A server hiccup answering with no students used to wipe the local
   * roster, and the 15-minute refresh throttle then kept it wiped — every
   * student reading "Not in roster" for the rest of an offline event.
   */
  it("refuses to wipe a populated roster with an empty payload", async () => {
    await db.replaceRoster(STUDENTS);

    await expect(db.replaceRoster([])).resolves.toEqual({ replaced: false, count: 2 });
    await expect(db.getRosterCount()).resolves.toBe(2);
  });

  it("accepts an empty roster when there was nothing to lose", async () => {
    await expect(db.replaceRoster([])).resolves.toEqual({ replaced: true, count: 0 });
  });

  it("derives the event-scoping facets from the roster", async () => {
    await db.replaceRoster(STUDENTS);
    await expect(db.getRosterFacets()).resolves.toEqual({
      courses: ["BSCS", "BSIT"],
      yearLevels: ["1st", "2nd"],
    });
  });
});

describe("log queries", () => {
  beforeEach(async () => {
    await db.replaceRoster([
      { studentNumber: "S2012345678", name: "Ana Reyes", course: "BSIT", yearLevel: "1st" },
    ]);
  });

  it("joins roster details in a single query", async () => {
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });
    await db.insertAttendance({ studentNumber: "S2099999999", eventId: "ev1" });

    const rows = await db.getEntriesWithStudents({ eventId: "ev1" });
    const known = rows.find((r) => r.studentNumber === "S2012345678");
    const unknown = rows.find((r) => r.studentNumber === "S2099999999");

    expect(known?.studentName).toBe("Ana Reyes");
    expect(known?.studentCourse).toBe("BSIT");
    // Still listed, just flagged as off-roster rather than dropped.
    expect(unknown?.studentName).toBeNull();
  });

  it("searches by number or name", async () => {
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });
    await db.insertAttendance({ studentNumber: "S2099999999", eventId: "ev1" });

    await expect(db.getEntriesWithStudents({ eventId: "ev1", search: "REYES" })).resolves.toHaveLength(1);
    await expect(db.getEntriesWithStudents({ eventId: "ev1", search: "99999" })).resolves.toHaveLength(1);
  });

  it("pages through a long log", async () => {
    for (let i = 0; i < 25; i++) {
      await db.insertAttendance({
        studentNumber: "S2012345678",
        eventId: "ev1",
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
      });
    }

    const first = await db.getEntriesWithStudents({ eventId: "ev1", limit: 10, offset: 0 });
    const second = await db.getEntriesWithStudents({ eventId: "ev1", limit: 10, offset: 10 });

    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(new Set([...first, ...second].map((r) => r.id)).size).toBe(20);
  });

  it("exports every entry for the event, not just the visible page", async () => {
    for (let i = 0; i < 12; i++) {
      await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });
    }
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "other" });

    const exported = await db.getAllEntriesForExport("ev1");
    expect(exported).toHaveLength(12);
  });
});

describe("account switching", () => {
  it("clears every cached record but keeps the device identity", async () => {
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });
    await db.upsertRemoteEvents([{ id: "ev1", name: "Orientation" }]);
    await db.replaceRoster([
      { studentNumber: "S2012345678", name: "Ana", course: "BSIT", yearLevel: "1st" },
    ]);
    await db.setMeta("last_attendance_sync", "2026-09-20T00:00:00.000Z");
    const deviceId = await db.getMeta("device_id");
    expect(deviceId).toBeTruthy();

    await db.resetLocalData();

    // Nothing of the previous staff member's session survives — above all
    // not their unsynced queue, which would otherwise upload under the
    // new person's token.
    await expect(db.getPendingCount()).resolves.toBe(0);
    await expect(db.getEvents()).resolves.toHaveLength(0);
    await expect(db.getRosterCount()).resolves.toBe(0);
    await expect(db.getMeta("last_attendance_sync")).resolves.toBeNull();
    // The device id must survive so replayed row ids stay unique.
    await expect(db.getMeta("device_id")).resolves.toBe(deviceId);
  });
});

describe("event eligibility", () => {
  const student = {
    studentNumber: "S2012345678",
    name: "Ana",
    course: "BSIT",
    yearLevel: "1st",
  };

  it("allows everyone when the event is unscoped", () => {
    const event = { ...EVENT_INPUT, id: "ev1", description: null, startsAt: null, endsAt: null };
    expect(db.checkEventEligibility(event, student)).toBeNull();
  });

  it("warns when the student's course or year is out of scope", () => {
    const byCourse = {
      ...EVENT_INPUT,
      id: "ev1",
      description: null,
      startsAt: null,
      endsAt: null,
      courses: ["BSCS"],
    };
    expect(db.checkEventEligibility(byCourse, student)).toMatch(/course list/);

    const byYear = {
      ...EVENT_INPUT,
      id: "ev1",
      description: null,
      startsAt: null,
      endsAt: null,
      yearLevels: ["4th"],
    };
    expect(db.checkEventEligibility(byYear, student)).toMatch(/year level list/);
  });

  it("stays quiet for someone who isn't on the roster at all", () => {
    const event = { ...EVENT_INPUT, id: "ev1", description: null, startsAt: null, endsAt: null, courses: ["BSCS"] };
    // That case has its own dedicated "Not in roster" state.
    expect(db.checkEventEligibility(event, null)).toBeNull();
  });
});
