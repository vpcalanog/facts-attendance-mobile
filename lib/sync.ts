import NetInfo from "@react-native-community/netinfo";
import { authFetch } from "./api";
import {
  applyEventSyncResult,
  getMeta,
  getPendingEntries,
  getPendingEvents,
  markPushFailed,
  markSynced,
  pruneMissingEvents,
  RemoteEntry,
  RemoteEvent,
  replaceRoster,
  setMeta,
  upsertRemoteEntries,
  upsertRemoteEvents,
} from "./db";
import { isCancelled, toAppError } from "./errors";
import { log } from "./logger";

const LAST_ATTENDANCE_SYNC_KEY = "last_attendance_sync";
const LAST_ROSTER_SYNC_KEY = "last_roster_sync";
const LAST_EVENTS_SYNC_KEY = "last_events_sync";
const ROSTER_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const EVENTS_REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 min — events change more often than the roster

/** One push carries at most this many rows; a backlog is drained across
 *  several requests in the same pass rather than one enormous body. */
const PUSH_BATCH_SIZE = 200;
const MAX_PUSH_BATCHES = 10;

export async function isOnline(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return Boolean(state.isConnected && state.isInternetReachable !== false);
  } catch {
    // If we can't even ask, assume we're online and let the request fail
    // with a real error rather than silently skipping the sync forever.
    return true;
  }
}

// --- backoff ----------------------------------------------------------
//
// The old engine retried on a flat 60s timer plus every NetInfo change
// plus every foreground event. Against a server that is down — the state
// the app is in right now, with the tunnel offline — that is a request
// every few seconds, forever, draining the battery and the data plan.

let consecutiveFailures = 0;
let nextAttemptAt = 0;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

function backoffDelay(failures: number): number {
  const exponential = BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 6);
  // Jitter keeps a room full of devices from retrying in lockstep after a
  // server comes back up.
  const jitter = Math.random() * 0.3 * exponential;
  return Math.min(exponential + jitter, BACKOFF_MAX_MS);
}

function noteFailure() {
  consecutiveFailures += 1;
  const delay = backoffDelay(consecutiveFailures);
  nextAttemptAt = Date.now() + delay;
  log.warn("sync failed; backing off", {
    consecutiveFailures,
    retryInSeconds: Math.round(delay / 1000),
  });
}

function noteSuccess() {
  if (consecutiveFailures) log.info("sync recovered", { afterFailures: consecutiveFailures });
  consecutiveFailures = 0;
  nextAttemptAt = 0;
}

/** Cleared on sign-out so the next account doesn't inherit a penalty box. */
export function resetSyncBackoff(): void {
  consecutiveFailures = 0;
  nextAttemptAt = 0;
}

export function getBackoffState() {
  return { consecutiveFailures, nextAttemptAt };
}

// --- response normalization -------------------------------------------

/** The reject list's element shape isn't pinned down by the API, so accept
 *  the plausible spellings rather than silently dropping failures. */
function normalizeRejections(raw: unknown): { ids: string[]; reason: string } {
  if (!Array.isArray(raw) || !raw.length) return { ids: [], reason: "" };
  const ids: string[] = [];
  let reason = "";
  for (const item of raw) {
    if (typeof item === "string") {
      ids.push(item);
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id = o.id ?? o.entryId ?? o.tempId;
      if (typeof id === "string") ids.push(id);
      if (!reason && typeof o.reason === "string") reason = o.reason;
      if (!reason && typeof o.error === "string") reason = o.error;
    }
  }
  return { ids, reason: reason || "Rejected by the server." };
}

function asStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function isUsableTimestamp(value: unknown): value is string {
  return typeof value === "string" && !!value && !Number.isNaN(new Date(value).getTime());
}

// --- individual stages -------------------------------------------------

export interface PushResult {
  pushed: number;
  rejected: number;
  remaining: number;
}

/**
 * Pushes locally logged attendance up to the server, draining the queue
 * across batches.
 *
 * Idempotency: row ids are generated on-device and sent unchanged, so a
 * reply lost to a timeout is safe to replay — the server upserts on id.
 * What is *not* safe is leaving a row the server explicitly refused in the
 * queue forever, which the old code did: it only marked the accepted ids
 * and silently re-sent the rest on every pass, so one invalid row kept the
 * pending badge permanently wrong. Refusals are counted and eventually
 * dead-lettered.
 */
export async function pushPendingAttendance(signal?: AbortSignal): Promise<PushResult> {
  let pushed = 0;
  let rejected = 0;

  for (let batch = 0; batch < MAX_PUSH_BATCHES; batch++) {
    const pending = await getPendingEntries(PUSH_BATCH_SIZE);
    if (!pending.length) return { pushed, rejected, remaining: 0 };

    const data = await authFetch<{ acceptedIds?: unknown; rejected?: unknown }>(
      "/api/attendance/sync",
      { method: "POST", body: JSON.stringify({ entries: pending }), signal }
    );

    const accepted = asStringArray(data.acceptedIds);
    const { ids: rejectedIds, reason } = normalizeRejections(data.rejected);

    await markSynced(accepted);
    if (rejectedIds.length) await markPushFailed(rejectedIds, reason);

    // Rows the server acknowledged neither way: count an attempt so a
    // permanently-ignored row eventually dead-letters instead of looping.
    const handled = new Set([...accepted, ...rejectedIds]);
    const unacknowledged = pending.filter((p) => !handled.has(p.id)).map((p) => p.id);
    if (unacknowledged.length) {
      await markPushFailed(unacknowledged, "The server did not acknowledge this entry.");
    }

    pushed += accepted.length;
    rejected += rejectedIds.length;

    // Nothing moved: stop rather than spin through all ten batches.
    if (!accepted.length) break;
    if (pending.length < PUSH_BATCH_SIZE) break;
  }

  const stillPending = await getPendingEntries(1);
  return { pushed, rejected, remaining: stillPending.length };
}

// Pull attendance logged on OTHER devices since our last known point.
export async function pullRemoteAttendance(signal?: AbortSignal): Promise<{ pulled: number }> {
  const since = await getMeta(LAST_ATTENDANCE_SYNC_KEY);
  const data = await authFetch<{ entries?: unknown; serverTime?: unknown }>(
    `/api/attendance/sync${since ? `?since=${encodeURIComponent(since)}` : ""}`,
    { signal }
  );

  const entries = Array.isArray(data.entries) ? (data.entries as RemoteEntry[]) : [];
  // Store rows before advancing the cursor. If the app dies in between we
  // re-pull the same window, which is harmless (INSERT OR IGNORE); the
  // reverse order would lose entries permanently.
  await upsertRemoteEntries(entries);

  if (isUsableTimestamp(data.serverTime)) {
    await setMeta(LAST_ATTENDANCE_SYNC_KEY, data.serverTime);
  } else {
    // Advancing to a bad value used to poison every later request with
    // `?since=undefined`. Leaving the cursor put means the next pass
    // re-reads a slightly wider window — correct, just less efficient.
    log.warn("server omitted a usable serverTime; leaving the attendance cursor unchanged");
  }
  return { pulled: entries.length };
}

export async function pullRoster(
  { force = false }: { force?: boolean } = {},
  signal?: AbortSignal
): Promise<{ students?: number; skipped?: boolean; replaced?: boolean }> {
  if (!force && (await isFresh(LAST_ROSTER_SYNC_KEY, ROSTER_REFRESH_INTERVAL_MS))) {
    return { skipped: true };
  }
  const data = await authFetch<{ students?: unknown }>("/api/students", { signal });
  const students = Array.isArray(data.students) ? data.students : [];
  const { replaced, count } = await replaceRoster(students as any);
  await setMeta(LAST_ROSTER_SYNC_KEY, new Date().toISOString());
  return { students: count, replaced };
}

/**
 * Push events created on-device (by an admin) up to the server. The server
 * assigns the real id; `accepted` maps each temp local id to the server's
 * version of that event so we can replace it locally and re-point any
 * attendance already logged against the temp id.
 *
 * ASSUMED CONTRACT — matches the existing /api/attendance/sync shape:
 *   POST /api/events/sync  { events: EventRow[] }
 *   -> { accepted: [{ tempId, event: RemoteEvent }], rejected?: any[] }
 */
export async function pushPendingEvents(signal?: AbortSignal): Promise<{ pushed: number }> {
  const pending = await getPendingEvents(50);
  if (!pending.length) return { pushed: 0 };

  const data = await authFetch<{ accepted?: unknown }>("/api/events/sync", {
    method: "POST",
    body: JSON.stringify({ events: pending }),
    signal,
  });

  const accepted = (Array.isArray(data.accepted) ? data.accepted : []).filter(
    (a: any): a is { tempId: string; event: RemoteEvent } =>
      !!a && typeof a.tempId === "string" && !!a.event && typeof a.event.id === "string"
  );
  await applyEventSyncResult(accepted);
  return { pushed: accepted.length };
}

/** ASSUMED CONTRACT: GET /api/events -> { events: RemoteEvent[] } */
export async function pullEvents(
  { force = false }: { force?: boolean } = {},
  signal?: AbortSignal
): Promise<{ events?: number; skipped?: boolean; pruned?: number }> {
  if (!force && (await isFresh(LAST_EVENTS_SYNC_KEY, EVENTS_REFRESH_INTERVAL_MS))) {
    return { skipped: true };
  }
  const data = await authFetch<{ events?: unknown }>("/api/events", { signal });
  const events = Array.isArray(data.events) ? (data.events as RemoteEvent[]) : [];
  await upsertRemoteEvents(events);
  // The response is the server's full list, so anything synced that is
  // absent from it has been deleted upstream.
  const pruned = await pruneMissingEvents(
    events.map((e) => e?.id).filter((id): id is string => typeof id === "string")
  );
  await setMeta(LAST_EVENTS_SYNC_KEY, new Date().toISOString());
  return { events: events.length, pruned };
}

async function isFresh(key: string, intervalMs: number): Promise<boolean> {
  const last = await getMeta(key);
  if (!last) return false;
  const age = Date.now() - new Date(last).getTime();
  // A negative age means the clock moved backwards (or the stored value is
  // junk). Treat it as stale so the data can never get stuck un-refreshed.
  if (Number.isNaN(age) || age < 0) return false;
  return age < intervalMs;
}

// --- orchestration -----------------------------------------------------

export type StageName = "eventsPush" | "eventsPull" | "attendancePush" | "attendancePull" | "roster";

export interface SyncResult {
  online: boolean;
  /** Set when the pass was skipped because we're still in backoff. */
  deferred?: boolean;
  stages: Partial<Record<StageName, { ok: boolean; error?: string; data?: unknown }>>;
  /** First real failure, for the status badge. */
  error?: string;
  /** True when the server rejected our token; the auth layer has already
   *  been notified via the api.ts auth-failure handler. */
  authFailed?: boolean;
  pushed: number;
  pulled: number;
}

async function runStage<T>(
  name: StageName,
  result: SyncResult,
  fn: () => Promise<T>
): Promise<T | null> {
  try {
    const data = await fn();
    result.stages[name] = { ok: true, data };
    return data;
  } catch (err) {
    const e = toAppError(err);
    if (isCancelled(e)) {
      result.stages[name] = { ok: false, error: "cancelled" };
      return null;
    }
    if (e.kind === "auth") result.authFailed = true;
    result.stages[name] = { ok: false, error: e.message };
    // First real error wins the summary slot; later stages still run.
    if (!result.error) result.error = e.message;
    log.warn("sync stage failed", { stage: name, kind: e.kind });
    return null;
  }
}

/**
 * Runs a full sync pass.
 *
 * Every stage is independent. The old version ran all five inside one
 * try block, so a single failing endpoint — /api/events/sync, whose
 * contract is still an assumption — aborted the pass before attendance
 * was ever uploaded. Uploading scans is the one thing this app cannot
 * afford to skip, so a broken events endpoint must not be able to block
 * it.
 *
 * Never throws: callers (a timer, a NetInfo listener, a pull-to-refresh)
 * read `result.error` instead.
 */
export async function runSync({
  forceRoster = false,
  forceEvents = false,
  bypassBackoff = false,
  signal,
}: {
  forceRoster?: boolean;
  forceEvents?: boolean;
  /** Set for user-initiated syncs, which should always try immediately. */
  bypassBackoff?: boolean;
  signal?: AbortSignal;
} = {}): Promise<SyncResult> {
  const result: SyncResult = { online: true, stages: {}, pushed: 0, pulled: 0 };

  if (!(await isOnline())) {
    return { ...result, online: false };
  }
  if (!bypassBackoff && nextAttemptAt && Date.now() < nextAttemptAt) {
    return { ...result, deferred: true };
  }

  // Events are pushed first so a scan taken against a just-created event
  // has the real server id to reconcile against on the very next pull.
  await runStage("eventsPush", result, () => pushPendingEvents(signal));
  await runStage("eventsPull", result, () => pullEvents({ force: forceEvents }, signal));

  const push = await runStage("attendancePush", result, () => pushPendingAttendance(signal));
  if (push) result.pushed = push.pushed;

  const pull = await runStage("attendancePull", result, () => pullRemoteAttendance(signal));
  if (pull) result.pulled = pull.pulled;

  await runStage("roster", result, () => pullRoster({ force: forceRoster }, signal));

  // An auth failure is not a transport problem — the auth layer is already
  // signing the user out, so don't also start a backoff timer for it.
  if (result.error && !result.authFailed) noteFailure();
  else if (!result.error) noteSuccess();

  return result;
}
