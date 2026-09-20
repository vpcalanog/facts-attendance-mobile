import type { StaffUser } from "./auth";
import { AttendanceRow, findRecentDuplicate, findStudent, insertAttendance, RosterRow } from "./db";
import { isValidId } from "./extract";
import { log } from "./logger";

/** How long after a scan a second scan of the same student at the same
 *  event is treated as an accidental double-tap rather than a real
 *  second check-in. */
export const DUP_WINDOW_MS = 5 * 60 * 1000;

/** A course + year-level pair, e.g. BSIT / 3rd Year. */
export interface Cohort {
  course: string;
  yearLevel: string;
}

/**
 * Course and year-level strings originate from a spreadsheet, so
 * "3rd Year", "3rd year" and " BSIT " all turn up. Compare on a
 * normalized form — a rule that silently stops applying because of a
 * stray capital is worse than no rule.
 */
function norm(value: string | null | undefined): string {
  return (value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

export function sameCohort(a: Cohort | null, b: Cohort | null): boolean {
  if (!a || !b) return false;
  if (!norm(a.course) || !norm(a.yearLevel)) return false;
  return norm(a.course) === norm(b.course) && norm(a.yearLevel) === norm(b.yearLevel);
}

/**
 * The conflict-of-interest rule: an officer may not register attendance
 * for students in their own course AND year level — their direct
 * classmates. Officers in the same course but a different year, or the
 * same year in a different course, are unaffected.
 *
 * Returns null when the scan is allowed, or the reason it is not.
 *
 * This is a client-side guard for a client-side mistake. It is not a
 * security control: anyone who can reach the API can post an entry
 * directly, so the server must apply the identical rule. See
 * credentials-out/officers-seed.json, which carries each officer's
 * cohort for exactly that purpose.
 */
export function checkOfficerCohortConflict(
  officerCohort: Cohort | null,
  student: RosterRow | null
): string | null {
  if (!officerCohort || !student) return null;
  if (!sameCohort(officerCohort, { course: student.course, yearLevel: student.yearLevel })) {
    return null;
  }
  return (
    `You can't log ${student.course} ${student.yearLevel} students — that's your own ` +
    `course and year level. Ask another officer to scan this student.`
  );
}

export type LogAttendanceResult =
  /** Written to the local queue. */
  | { status: "logged"; row: AttendanceRow; student: RosterRow | null }
  /** Refused outright. Not overridable. */
  | { status: "blocked"; reason: "cohort" | "invalid"; message: string }
  /** Already logged recently; caller may retry with force. */
  | { status: "needs-confirmation"; reason: "duplicate"; message: string; minutesAgo: number };

/**
 * The single path by which attendance gets recorded.
 *
 * The scan screen and the manual screen previously each carried their
 * own copy of the duplicate-window check and insert, which is how they
 * came to disagree in small ways. Keeping the decision here means a new
 * rule — like the cohort restriction — cannot be enforced on one screen
 * and forgotten on the other.
 */
export async function logAttendance({
  studentNumber,
  eventId,
  officer,
  officerCohort,
  force = false,
}: {
  studentNumber: string;
  eventId: string;
  officer: StaffUser | null;
  officerCohort: Cohort | null;
  /** Set once the user has acknowledged a duplicate warning. */
  force?: boolean;
}): Promise<LogAttendanceResult> {
  if (!isValidId(studentNumber)) {
    return { status: "blocked", reason: "invalid", message: "That isn't a valid student number." };
  }
  if (!eventId) {
    return { status: "blocked", reason: "invalid", message: "No event selected." };
  }

  const student = await findStudent(studentNumber);

  // Checked before the duplicate window on purpose: a refused scan must
  // never be presented with a "Log anyway" button.
  const conflict = checkOfficerCohortConflict(officerCohort, student);
  if (conflict) {
    log.info("blocked same-cohort scan", {
      officer: officer?.username,
      cohort: `${officerCohort?.course}/${officerCohort?.yearLevel}`,
    });
    return { status: "blocked", reason: "cohort", message: conflict };
  }

  if (!force) {
    const dup = await findRecentDuplicate(studentNumber, DUP_WINDOW_MS, eventId);
    if (dup) {
      const minutesAgo = Math.max(
        1,
        Math.round((Date.now() - new Date(dup.timestamp).getTime()) / 60000)
      );
      return {
        status: "needs-confirmation",
        reason: "duplicate",
        minutesAgo,
        message: `${studentNumber} was logged ${minutesAgo} min ago at this event.`,
      };
    }
  }

  const row = await insertAttendance({
    studentNumber,
    eventId,
    loggedBy: officer?.username,
  });
  return { status: "logged", row, student };
}
