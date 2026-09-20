import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import type { Cohort } from "@/lib/attendance";
import { findStudent } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { useEffect, useRef, useState } from "react";

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
  const [cohort, setCohort] = useState<Cohort | null>(null);
  const [status, setStatus] = useState<CohortStatus>("unrestricted");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const course = user?.course ?? null;
  const yearLevel = user?.yearLevel ?? null;
  const studentNumber = user?.studentNumber ?? null;

  useEffect(() => {
    let cancelled = false;

    if (course && yearLevel) {
      setCohort({ course, yearLevel });
      setStatus("resolved");
      return;
    }

    if (!studentNumber) {
      // An admin account, or a server that sends neither. Unrestricted.
      setCohort(null);
      setStatus("unrestricted");
      return;
    }

    void (async () => {
      try {
        const row = await findStudent(studentNumber);
        if (cancelled || !mounted.current) return;
        if (row?.course && row?.yearLevel) {
          setCohort({ course: row.course, yearLevel: row.yearLevel });
          setStatus("resolved");
        } else {
          // Deliberately fails open rather than blocking every scan: an
          // officer who can't check anyone in is worse than one relying
          // on the server's copy of the same rule. The screens surface
          // this state so it isn't silent.
          setCohort(null);
          setStatus("pending");
        }
      } catch (err) {
        log.warn("couldn't resolve officer cohort", { message: toAppError(err).message });
        if (!cancelled && mounted.current) {
          setCohort(null);
          setStatus("pending");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [course, yearLevel, studentNumber, lastSyncAt]);

  return { cohort, status };
}
