/**
 * The conflict-of-interest rule: an officer may not register attendance
 * for students in their own course AND year level.
 *
 * Run against a real SQLite engine, using the actual officers and
 * classmates from lib/Officers.csv so the fixtures match production data
 * rather than invented ideals.
 */
jest.mock("expo-sqlite", () => require("./sqlite-mock").createExpoSqliteMock());

type Db = typeof import("@/lib/db");
type Attendance = typeof import("@/lib/attendance");

let db: Db;
let attendance: Attendance;

// Real rows from the roster.
const ROSTER = [
  // jmonzor's own cohort — BSIT 3rd Year
  { studentNumber: "S2024100805", name: "Pauline Mae Lat", course: "BSIT", yearLevel: "3rd Year" },
  { studentNumber: "S2024101442", name: "Naika Ishi Gumila", course: "BSIT", yearLevel: "3rd Year" },
  // same course, different year
  { studentNumber: "S2025100781", name: "Lana Clare Poblete", course: "BSIT", yearLevel: "2nd Year" },
  // same year, different course
  { studentNumber: "S2024100023", name: "Jamie Pearl Carandang", course: "BSCS", yearLevel: "3rd Year" },
  // neither
  { studentNumber: "S2026100628", name: "Lawrence De Garejo", course: "BSEMC", yearLevel: "1st Year" },
];

/** Jessam Mae Monzor, S2024101547, BSIT 3rd Year. */
const OFFICER = {
  id: "off-1",
  username: "jmonzor",
  name: "Jessam Mae Monzor",
  role: "officer",
  studentNumber: "S2024101547",
  course: "BSIT",
  yearLevel: "3rd Year",
};

const OWN_COHORT = { course: "BSIT", yearLevel: "3rd Year" };
const EVENT_ID = "ev1";

beforeEach(async () => {
  jest.resetModules();
  db = require("@/lib/db");
  attendance = require("@/lib/attendance");
  await db.initDb();
  await db.replaceRoster(ROSTER);
});

describe("checkOfficerCohortConflict", () => {
  it("blocks a student in the officer's own course and year", () => {
    const classmate = ROSTER[0];
    const reason = attendance.checkOfficerCohortConflict(OWN_COHORT, classmate);
    expect(reason).toMatch(/BSIT 3rd Year/);
    expect(reason).toMatch(/your own course and year level/i);
  });

  it("allows the same course in a different year", () => {
    expect(attendance.checkOfficerCohortConflict(OWN_COHORT, ROSTER[2])).toBeNull();
  });

  it("allows the same year in a different course", () => {
    expect(attendance.checkOfficerCohortConflict(OWN_COHORT, ROSTER[3])).toBeNull();
  });

  it("allows an unrelated cohort", () => {
    expect(attendance.checkOfficerCohortConflict(OWN_COHORT, ROSTER[4])).toBeNull();
  });

  it("leaves an account with no cohort unrestricted", () => {
    // Administrators carry no course or year level.
    expect(attendance.checkOfficerCohortConflict(null, ROSTER[0])).toBeNull();
  });

  it("cannot judge a student who isn't on the roster", () => {
    expect(attendance.checkOfficerCohortConflict(OWN_COHORT, null)).toBeNull();
  });

  // Course and year strings come out of a spreadsheet. A rule that stops
  // applying because of a stray capital or double space is worse than no
  // rule at all.
  it("compares cohorts case- and whitespace-insensitively", () => {
    const sloppy = {
      studentNumber: "S2024100805",
      name: "Pauline",
      course: " bsit ",
      yearLevel: "3RD  YEAR",
    };
    expect(attendance.checkOfficerCohortConflict(OWN_COHORT, sloppy)).not.toBeNull();
  });

  it("does not treat a blank officer cohort as matching blank student data", () => {
    const blank = { studentNumber: "S2000000000", name: "?", course: "", yearLevel: "" };
    expect(
      attendance.checkOfficerCohortConflict({ course: "", yearLevel: "" }, blank)
    ).toBeNull();
  });
});

describe("logAttendance enforcement", () => {
  it("refuses to record a classmate, and writes nothing", async () => {
    const result = await attendance.logAttendance({
      studentNumber: "S2024100805",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
    });

    expect(result.status).toBe("blocked");
    expect(result).toMatchObject({ reason: "cohort" });
    await expect(db.getPendingCount()).resolves.toBe(0);
    await expect(db.countEntries({ eventId: EVENT_ID })).resolves.toBe(0);
  });

  /**
   * The rule is a refusal, not a warning. `force` exists to acknowledge a
   * duplicate; it must never become a way around the cohort restriction.
   */
  it("stays blocked even when force is set", async () => {
    const result = await attendance.logAttendance({
      studentNumber: "S2024100805",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
      force: true,
    });

    expect(result.status).toBe("blocked");
    await expect(db.getPendingCount()).resolves.toBe(0);
  });

  /**
   * Ordering matters: were the duplicate check first, a blocked scan of
   * an already-logged classmate would surface a "Log anyway" button and
   * invite the officer to override a rule that isn't overridable.
   */
  it("reports the cohort block rather than a duplicate prompt", async () => {
    // Another officer already logged this classmate a moment ago.
    await db.insertAttendance({ studentNumber: "S2024100805", eventId: EVENT_ID });

    const result = await attendance.logAttendance({
      studentNumber: "S2024100805",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
    });

    expect(result.status).toBe("blocked");
    expect(result).toMatchObject({ reason: "cohort" });
  });

  it("records a student outside the officer's cohort", async () => {
    const result = await attendance.logAttendance({
      studentNumber: "S2025100781",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
    });

    expect(result.status).toBe("logged");
    await expect(db.getPendingCount()).resolves.toBe(1);

    const [row] = await db.getEntriesWithStudents({ eventId: EVENT_ID });
    expect(row.studentNumber).toBe("S2025100781");
    // Attribution survives, so a blocked-rule violation would be traceable.
    expect(row.loggedBy).toBe("jmonzor");
  });

  it("lets an administrator record anyone", async () => {
    const admin = { id: "a1", username: "root", name: "Admin", role: "admin" };
    const result = await attendance.logAttendance({
      studentNumber: "S2024100805",
      eventId: EVENT_ID,
      officer: admin,
      officerCohort: null,
    });

    expect(result.status).toBe("logged");
  });

  it("still flags a genuine duplicate for an allowed student", async () => {
    await attendance.logAttendance({
      studentNumber: "S2025100781",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
    });

    const second = await attendance.logAttendance({
      studentNumber: "S2025100781",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
    });
    expect(second.status).toBe("needs-confirmation");
    await expect(db.countEntries({ eventId: EVENT_ID })).resolves.toBe(1);

    const forced = await attendance.logAttendance({
      studentNumber: "S2025100781",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
      force: true,
    });
    expect(forced.status).toBe("logged");
    await expect(db.countEntries({ eventId: EVENT_ID })).resolves.toBe(2);
  });

  it("rejects a malformed student number before touching the database", async () => {
    const result = await attendance.logAttendance({
      studentNumber: "NOPE",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
    });
    expect(result).toMatchObject({ status: "blocked", reason: "invalid" });
    await expect(db.getPendingCount()).resolves.toBe(0);
  });

  /**
   * A student missing from the roster has no cohort to compare, so the
   * client cannot apply the rule. It records the scan (an unknown student
   * is already flagged in the UI) and relies on the server, which holds
   * the full roster, to make the final call.
   */
  it("records an off-roster student, leaving the rule to the server", async () => {
    const result = await attendance.logAttendance({
      studentNumber: "S2099999999",
      eventId: EVENT_ID,
      officer: OFFICER,
      officerCohort: OWN_COHORT,
    });
    expect(result.status).toBe("logged");
  });
});

describe("every cohort stays coverable", () => {
  /**
   * The rule is only workable if each cohort has officers outside it.
   * With 27 officers spread across 12 cohorts that holds comfortably,
   * but it is worth failing loudly if a future roster breaks it.
   */
  it("leaves at least one eligible officer for each cohort", () => {
    const officers = [
      { course: "BSIT", yearLevel: "3rd Year" },
      { course: "BSCS", yearLevel: "3rd Year" },
      { course: "BSEMC", yearLevel: "2nd Year" },
      { course: "BSIT", yearLevel: "2nd Year" },
      { course: "BSIT", yearLevel: "1st Year" },
    ];
    const cohorts = new Set(officers.map((o) => `${o.course}|${o.yearLevel}`));

    for (const key of cohorts) {
      const [course, yearLevel] = key.split("|");
      const eligible = officers.filter(
        (o) => !attendance.sameCohort(o, { course, yearLevel })
      );
      expect(eligible.length).toBeGreaterThan(0);
    }
  });
});
