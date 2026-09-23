import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import type { Cohort } from "@/lib/attendance";
import { findStudent } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { useEffect, useState } from "react";

export type CohortStatus =
  /** No restriction applies — an administrator, or an account with no
   *  student identity attached. */
  | "unrestricted"
  /** We know which cohort to block. */
  | "resolved"
  /** The account is a student officer, but we can't tell which cohort
   *  yet because the roster hasn't reached this device. */
  | "pending";

/**
 * Works out which cohort the signed-in officer belongs to, so the app
 * can stop them registering their own classmates.
 *
 * Two sources, in order:
 *   1. course + yearLevel straight off the session, if the server sends
 *      them. This is the intended path.
 *   2. a roster lookup by the account's studentNumber, for a server that
 *      only sends the number.
 *
 * Re-resolves after each sync, because on a fresh install the roster
 * arrives shortly *after* sign-in and path 2 would otherwise stay stuck.
 */
export function useOfficerCohort(): { cohort: Cohort | null; status: CohortStatus } {
  const { user } = useAuth();
  const { lastSyncAt } = useSync();
  // Only the roster lookup is state. Keyed by student number so a result
  // for a previous account can never apply to the current one.
  const [lookup, setLookup] = useState<{ studentNumber: string; cohort: Cohort | null } | null>(
    null
  );

  const course = user?.course ?? null;
  const yearLevel = user?.yearLevel ?? null;
  const studentNumber = user?.studentNumber ?? null;
  const fromSession = !!(course && yearLevel);

  useEffect(() => {
    if (fromSession || !studentNumber) return;
    let cancelled = false;

    void (async () => {
      try {
        const row = await findStudent(studentNumber);
        if (cancelled) return;
        setLookup({
          studentNumber,
          cohort:
            row?.course && row?.yearLevel ? { course: row.course, yearLevel: row.yearLevel } : null,
        });
      } catch (err) {
        log.warn("couldn't resolve officer cohort", { message: toAppError(err).message });
        if (!cancelled) setLookup({ studentNumber, cohort: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fromSession, studentNumber, lastSyncAt]);

  if (course && yearLevel) return { cohort: { course, yearLevel }, status: "resolved" };
  // An admin account, or a server that sends neither. Unrestricted.
  if (!studentNumber) return { cohort: null, status: "unrestricted" };

  const cohort = lookup?.studentNumber === studentNumber ? lookup.cohort : null;
  // No cohort yet deliberately fails open rather than blocking every scan:
  // an officer who can't check anyone in is worse than one relying on the
  // server's copy of the same rule. The screens surface this state so it
  // isn't silent.
  return { cohort, status: cohort ? "resolved" : "pending" };
}
