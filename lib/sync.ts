import NetInfo from "@react-native-community/netinfo";
import { ApiError, authFetch } from "./api";
import {
    applyEventSyncResult,
    getMeta,
    getPendingEntries,
    getPendingEvents,
    markSynced,
    RemoteEntry,
    RemoteEvent,
    replaceRoster,
    setMeta,
    upsertRemoteEntries,
    upsertRemoteEvents,
} from "./db";

const LAST_ATTENDANCE_SYNC_KEY = "last_attendance_sync";
const LAST_ROSTER_SYNC_KEY = "last_roster_sync";
const LAST_EVENTS_SYNC_KEY = "last_events_sync";
const ROSTER_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const EVENTS_REFRESH_INTERVAL_MS = 2 * 60 * 1000; // 2 min — events change more often than the roster

export async function isOnline(): Promise<boolean> {
  const state = await NetInfo.fetch();
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

// Push locally logged, not-yet-synced attendance up to the server.
export async function pushPendingAttendance() {
  const pending = await getPendingEntries(200);
  if (!pending.length) return { pushed: 0 };

  const data = await authFetch("/api/attendance/sync", {
    method: "POST",
    body: JSON.stringify({ entries: pending }),
  });
  await markSynced(data.acceptedIds || []);
  return { pushed: (data.acceptedIds || []).length, rejected: data.rejected || [] };
}

// Pull attendance logged on OTHER devices since our last known point.
export async function pullRemoteAttendance() {
  const since = await getMeta(LAST_ATTENDANCE_SYNC_KEY);
  const data = await authFetch(`/api/attendance/sync${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  await upsertRemoteEntries((data.entries || []) as RemoteEntry[]);
  await setMeta(LAST_ATTENDANCE_SYNC_KEY, data.serverTime);
  return { pulled: (data.entries || []).length };
}

export async function pullRoster({ force = false }: { force?: boolean } = {}) {
  if (!force) {
    const last = await getMeta(LAST_ROSTER_SYNC_KEY);
    if (last && Date.now() - new Date(last).getTime() < ROSTER_REFRESH_INTERVAL_MS) {
      return { skipped: true };
    }
  }
  const data = await authFetch("/api/students");
  await replaceRoster(data.students || []);
  await setMeta(LAST_ROSTER_SYNC_KEY, new Date().toISOString());
  return { students: (data.students || []).length };
}

// Push events created on-device (by an admin) up to the server. The
// server assigns the real id; `accepted` maps each temp local id to the
// server's version of that event so we can replace it locally.
//
// ASSUMED CONTRACT — matches your existing /api/attendance/sync shape:
//   POST /api/events/sync  { events: EventRow[] }
//   -> { accepted: [{ tempId, event: RemoteEvent }], rejected?: any[] }
export async function pushPendingEvents() {
  const pending = await getPendingEvents(50);
  if (!pending.length) return { pushed: 0 };

  const data = await authFetch("/api/events/sync", {
    method: "POST",
    body: JSON.stringify({ events: pending }),
  });
  const accepted = (data.accepted || []) as { tempId: string; event: RemoteEvent }[];
  await applyEventSyncResult(accepted);
  return { pushed: accepted.length, rejected: data.rejected || [] };
}

// ASSUMED CONTRACT: GET /api/events -> { events: RemoteEvent[] }
export async function pullEvents({ force = false }: { force?: boolean } = {}) {
  if (!force) {
    const last = await getMeta(LAST_EVENTS_SYNC_KEY);
    if (last && Date.now() - new Date(last).getTime() < EVENTS_REFRESH_INTERVAL_MS) {
      return { skipped: true };
    }
  }
  const data = await authFetch("/api/events");
  await upsertRemoteEvents((data.events || []) as RemoteEvent[]);
  await setMeta(LAST_EVENTS_SYNC_KEY, new Date().toISOString());
  return { events: (data.events || []).length };
}

export interface SyncResult {
  online: boolean;
  push?: { pushed: number; rejected?: any[] };
  pull?: { pulled: number };
  roster?: { students?: number; skipped?: boolean };
  eventsPush?: { pushed: number; rejected?: any[] };
  events?: { events?: number; skipped?: boolean };
  error?: string;
}

// Runs a full sync pass: push what we owe the server (events, then
// attendance), pull what we're missing, refresh the roster and events
// occasionally. Safe to call often — a no-op besides one connectivity
// check when there's nothing to do, and it swallows network errors into
// `result.error` rather than throwing so callers (a 60s timer, a NetInfo
// listener) don't need try/catch.
export async function runSync({
  forceRoster = false,
  forceEvents = false,
}: { forceRoster?: boolean; forceEvents?: boolean } = {}): Promise<SyncResult> {
  if (!(await isOnline())) {
    return { online: false };
  }
  const result: SyncResult = { online: true };
  try {
    // Events pushed first so a scan against a just-created event has the
    // real server id to reconcile against on the very next pull.
    result.eventsPush = await pushPendingEvents();
    result.events = await pullEvents({ force: forceEvents });
    result.push = await pushPendingAttendance();
    result.pull = await pullRemoteAttendance();
    result.roster = await pullRoster({ force: forceRoster });
  } catch (err) {
    result.error = err instanceof ApiError ? err.message : "Sync failed.";
  }
  return result;
}
