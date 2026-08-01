import NetInfo from "@react-native-community/netinfo";
import { authFetch, ApiError } from "./api";
import {
  getPendingEntries,
  markSynced,
  upsertRemoteEntries,
  replaceRoster,
  getMeta,
  setMeta,
  RemoteEntry,
} from "./db";

const LAST_ATTENDANCE_SYNC_KEY = "last_attendance_sync";
const LAST_ROSTER_SYNC_KEY = "last_roster_sync";
const ROSTER_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min

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

export interface SyncResult {
  online: boolean;
  push?: { pushed: number; rejected?: any[] };
  pull?: { pulled: number };
  roster?: { students?: number; skipped?: boolean };
  error?: string;
}

// Runs a full sync pass: push what we owe the server, pull what we're
// missing, refresh the roster occasionally. Safe to call often — a no-op
// besides one connectivity check when there's nothing to do, and it
// swallows network errors into `result.error` rather than throwing so
// callers (a 60s timer, a NetInfo listener) don't need try/catch.
export async function runSync({ forceRoster = false }: { forceRoster?: boolean } = {}): Promise<SyncResult> {
  if (!(await isOnline())) {
    return { online: false };
  }
  const result: SyncResult = { online: true };
  try {
    result.push = await pushPendingAttendance();
    result.pull = await pullRemoteAttendance();
    result.roster = await pullRoster({ force: forceRoster });
  } catch (err) {
    result.error = err instanceof ApiError ? err.message : "Sync failed.";
  }
  return result;
}
