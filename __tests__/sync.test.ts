import { AppError } from "@/lib/errors";

// The sync engine's job is orchestration: which stages run, in what
// order, what happens to each one's failure, and what gets written back
// to the queue. Both the API and the database are faked so a test can
// say "the events endpoint is 404" and assert that attendance still
// uploaded.
jest.mock("@/lib/api", () => ({ authFetch: jest.fn() }));
jest.mock("@/lib/db", () => ({
  applyEventSyncResult: jest.fn(async () => {}),
  getMeta: jest.fn(async () => null),
  getPendingEntries: jest.fn(async () => []),
  getPendingEvents: jest.fn(async () => []),
  markPushFailed: jest.fn(async () => {}),
  markSynced: jest.fn(async () => {}),
  pruneMissingEvents: jest.fn(async () => 0),
  replaceRoster: jest.fn(async () => ({ replaced: true, count: 0 })),
  setMeta: jest.fn(async () => {}),
  upsertRemoteEntries: jest.fn(async () => {}),
  upsertRemoteEvents: jest.fn(async () => {}),
}));

import { authFetch } from "@/lib/api";
import * as db from "@/lib/db";
import NetInfo from "@react-native-community/netinfo";

import { resetSyncBackoff, runSync } from "@/lib/sync";

const mockFetch = authFetch as jest.Mock;
const mockDb = db as jest.Mocked<typeof db>;

/** Routes each endpoint to a handler so a test can fail exactly one. */
function routeApi(handlers: Record<string, (path: string) => unknown>) {
  mockFetch.mockImplementation(async (path: string) => {
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) return handler(path);
    }
    return {};
  });
}

const ENTRY = {
  id: "e1",
  studentNumber: "S2012345678",
  eventId: "ev1",
  timestamp: "2026-09-20T01:00:00.000Z",
  loggedBy: "amabini",
};

beforeEach(() => {
  resetSyncBackoff();
  (NetInfo.fetch as jest.Mock).mockResolvedValue({
    isConnected: true,
    isInternetReachable: true,
  });
  mockDb.getPendingEntries.mockResolvedValue([]);
  mockDb.getPendingEvents.mockResolvedValue([]);
  mockDb.getMeta.mockResolvedValue(null);
  mockDb.replaceRoster.mockResolvedValue({ replaced: true, count: 0 });
  mockDb.pruneMissingEvents.mockResolvedValue(0);
});

describe("runSync stage isolation", () => {
  /**
   * The regression that mattered most: every stage used to share one try
   * block, so one broken events endpoint aborted the pass before a single
   * scan was uploaded.
   */
  it("still uploads attendance when the events endpoint is broken", async () => {
    mockDb.getPendingEntries.mockResolvedValueOnce([ENTRY]).mockResolvedValue([]);

    routeApi({
      "/api/events": () => {
        throw new AppError("Not found", "validation", { status: 404 });
      },
      "/api/attendance/sync": () => ({ acceptedIds: ["e1"], serverTime: "2026-09-20T02:00:00.000Z" }),
      "/api/students": () => ({ students: [] }),
    });

    const result = await runSync();

    expect(result.stages.eventsPull?.ok).toBe(false);
    expect(result.stages.attendancePush?.ok).toBe(true);
    expect(result.stages.attendancePull?.ok).toBe(true);
    expect(result.stages.roster?.ok).toBe(true);
    expect(mockDb.markSynced).toHaveBeenCalledWith(["e1"]);
    // The failure is still reported, just not fatal.
    expect(result.error).toBe("Not found");
  });

  it("never pushes events; they are managed on the server", async () => {
    routeApi({
      "/api/events": () => ({ events: [] }),
      "/api/attendance/sync": () => ({ acceptedIds: [], serverTime: "2026-09-20T02:00:00.000Z" }),
      "/api/students": () => ({ students: [] }),
    });

    await runSync();

    const paths = mockFetch.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/api/events/sync");
  });

  it("makes no requests at all while offline", async () => {
    (NetInfo.fetch as jest.Mock).mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });

    await expect(runSync()).resolves.toMatchObject({ online: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("attendance push queue", () => {
  it("dead-letters entries the server explicitly refuses", async () => {
    mockDb.getPendingEntries.mockResolvedValueOnce([ENTRY]).mockResolvedValue([]);
    routeApi({
      "/api/attendance/sync": (path) =>
        path.includes("?") || !path.endsWith("sync")
          ? { entries: [], serverTime: "2026-09-20T02:00:00.000Z" }
          : { acceptedIds: [], rejected: [{ id: "e1", reason: "unknown event" }] },
    });

    await runSync();

    expect(mockDb.markPushFailed).toHaveBeenCalledWith(["e1"], "unknown event");
    expect(mockDb.markSynced).toHaveBeenCalledWith([]);
  });

  // Previously these rows were re-sent on every pass forever, so the
  // "N pending" badge could never reach zero and nobody was told why.
  it("counts an attempt for entries the server silently ignores", async () => {
    mockDb.getPendingEntries.mockResolvedValueOnce([ENTRY]).mockResolvedValue([]);
    routeApi({
      "/api/attendance/sync": () => ({ acceptedIds: [], serverTime: "2026-09-20T02:00:00.000Z" }),
    });

    await runSync();

    expect(mockDb.markPushFailed).toHaveBeenCalledWith(
      ["e1"],
      expect.stringMatching(/did not acknowledge/i)
    );
  });
});

describe("attendance pull cursor", () => {
  it("advances the cursor when the server returns a usable time", async () => {
    routeApi({
      "/api/attendance/sync": () => ({ entries: [], serverTime: "2026-09-20T02:00:00.000Z" }),
    });

    await runSync();

    expect(mockDb.setMeta).toHaveBeenCalledWith(
      "last_attendance_sync",
      "2026-09-20T02:00:00.000Z"
    );
  });

  // Writing `undefined` here used to throw inside SQLite, surfacing as a
  // generic "Sync failed." and poisoning later requests with
  // `?since=undefined`.
  it("leaves the cursor alone when the server omits serverTime", async () => {
    routeApi({ "/api/attendance/sync": () => ({ entries: [] }) });

    const result = await runSync();

    expect(result.stages.attendancePull?.ok).toBe(true);
    expect(mockDb.setMeta).not.toHaveBeenCalledWith("last_attendance_sync", expect.anything());
  });

  it("stores pulled entries before advancing the cursor", async () => {
    const order: string[] = [];
    mockDb.upsertRemoteEntries.mockImplementation(async () => {
      order.push("upsert");
    });
    mockDb.setMeta.mockImplementation(async (key: string) => {
      if (key === "last_attendance_sync") order.push("cursor");
    });
    routeApi({
      "/api/attendance/sync": () => ({
        entries: [{ id: "r1", studentNumber: "S2000000001", timestamp: "2026-09-20T01:00:00.000Z" }],
        serverTime: "2026-09-20T02:00:00.000Z",
      }),
    });

    await runSync();

    expect(order).toEqual(["upsert", "cursor"]);
  });
});

describe("events pull", () => {
  it("prunes events the server no longer lists", async () => {
    routeApi({
      "/api/events": () => ({ events: [{ id: "ev1", name: "Orientation" }] }),
      "/api/attendance/sync": () => ({ entries: [], serverTime: "2026-09-20T02:00:00.000Z" }),
    });

    await runSync({ forceEvents: true });

    expect(mockDb.pruneMissingEvents).toHaveBeenCalledWith(["ev1"]);
  });
});

describe("backoff", () => {
  it("defers an automatic retry after a failure but honours a manual one", async () => {
    routeApi({
      "/api/": () => {
        throw new AppError("Couldn't reach the server.", "network");
      },
    });

    const first = await runSync();
    expect(first.error).toBeTruthy();

    mockFetch.mockClear();
    const second = await runSync();
    expect(second.deferred).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();

    // Pull-to-refresh and "Sync now" must always actually try.
    const manual = await runSync({ bypassBackoff: true });
    expect(manual.deferred).toBeUndefined();
    expect(mockFetch).toHaveBeenCalled();
  });

  it("does not start a backoff timer for an expired session", async () => {
    routeApi({
      "/api/": () => {
        throw new AppError("Session expired.", "auth", { status: 401 });
      },
    });

    const first = await runSync();
    expect(first.authFailed).toBe(true);

    // Signing in again should work immediately, not sit in a penalty box.
    const second = await runSync();
    expect(second.deferred).toBeUndefined();
  });

  it("clears the backoff once a pass succeeds", async () => {
    routeApi({
      "/api/": () => {
        throw new AppError("Couldn't reach the server.", "network");
      },
    });
    await runSync();

    routeApi({
      "/api/attendance/sync": () => ({ entries: [], serverTime: "2026-09-20T02:00:00.000Z" }),
    });
    const recovered = await runSync({ bypassBackoff: true });
    expect(recovered.error).toBeUndefined();

    const next = await runSync();
    expect(next.deferred).toBeUndefined();
  });
});
