import { getFailedCount, getPendingCount, initDb, revivePushFailures } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { runSync, SyncResult } from "@/lib/sync";
import NetInfo from "@react-native-community/netinfo";
import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { useAuth } from "./auth-context";

export interface SyncOptions {
  forceRoster?: boolean;
  forceEvents?: boolean;
  /** Set by anything the user explicitly triggered (pull-to-refresh, the
   *  Sync now button) so it runs even while the engine is backing off. */
  userInitiated?: boolean;
}

interface SyncContextValue {
  dbReady: boolean;
  dbError: string | null;
  /** Entries waiting to upload. */
  pendingCount: number;
  /** Entries the server refused enough times that we stopped retrying. */
  failedCount: number;
  syncing: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  online: boolean;
  sync: (opts?: SyncOptions) => Promise<SyncResult | undefined>;
  refreshCounts: () => Promise<void>;
  retryFailed: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);
const AUTO_SYNC_INTERVAL_MS = 60 * 1000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  // Holds the pass currently in flight. Overlapping callers join it
  // instead of being dropped — the old code returned undefined to the
  // second caller, so a pull-to-refresh that landed during the 60s timer
  // tick stopped its spinner immediately and re-rendered stale rows.
  const inFlight = useRef<Promise<SyncResult | undefined> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    initDb()
      .then(() => {
        if (!cancelled) setDbReady(true);
      })
      .catch((err) => {
        // Previously an unhandled rejection: dbReady stayed false and the
        // app sat there looking fine while nothing could be saved.
        const message = toAppError(err).message;
        log.error("database init failed", { message });
        if (!cancelled) setDbError(message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCounts = useCallback(async () => {
    if (!dbReady) return;
    try {
      const [pending, failed] = await Promise.all([getPendingCount(), getFailedCount()]);
      if (!mounted.current) return;
      setPendingCount(pending);
      setFailedCount(failed);
    } catch (err) {
      log.warn("couldn't read pending counts", { message: toAppError(err).message });
    }
  }, [dbReady]);

  const sync = useCallback(
    async (opts?: SyncOptions): Promise<SyncResult | undefined> => {
      if (!dbReady || !user) return undefined;
      if (inFlight.current) return inFlight.current;

      const controller = new AbortController();
      abortRef.current = controller;
      setSyncing(true);

      const pass = (async () => {
        try {
          const result = await runSync({
            forceRoster: opts?.forceRoster,
            forceEvents: opts?.forceEvents,
            bypassBackoff: opts?.userInitiated,
            signal: controller.signal,
          });
          if (mounted.current) {
            setOnline(result.online);
            if (result.error) {
              setLastSyncError(result.error);
            } else if (!result.deferred) {
              setLastSyncError(null);
              setLastSyncAt(new Date().toISOString());
            }
          }
          await refreshCounts();
          return result;
        } catch (err) {
          // runSync is written not to throw, but a bug there must not be
          // able to strand the in-flight flag and kill syncing for the
          // rest of the session — which is exactly what used to happen.
          const message = toAppError(err).message;
          log.error("sync pass threw", { message });
          if (mounted.current) setLastSyncError(message);
          return undefined;
        } finally {
          inFlight.current = null;
          abortRef.current = null;
          if (mounted.current) setSyncing(false);
        }
      })();

      inFlight.current = pass;
      return pass;
    },
    [dbReady, user, refreshCounts]
  );

  const retryFailed = useCallback(async () => {
    if (!dbReady) return;
    const revived = await revivePushFailures();
    log.info("retrying dead-lettered entries", { revived });
    await refreshCounts();
    await sync({ userInitiated: true });
  }, [dbReady, refreshCounts, sync]);

  // Signing out mid-sync must not leave a request in flight carrying the
  // old bearer token, nor let its result land on the next account.
  useEffect(() => {
    const previous = userIdRef.current;
    userIdRef.current = user?.id ?? null;
    if (previous && previous !== (user?.id ?? null)) {
      abortRef.current?.abort();
      setLastSyncError(null);
      setLastSyncAt(null);
      setPendingCount(0);
      setFailedCount(0);
    }
  }, [user]);

  // Initial + periodic sync while foregrounded and logged in. runSync
  // enforces its own backoff, so a tick against a dead server is cheap.
  useEffect(() => {
    if (!dbReady || !user) return;
    void sync({ forceRoster: true, forceEvents: true, userInitiated: true });
    const interval = setInterval(() => void sync(), AUTO_SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dbReady, user, sync]);

  // Sync immediately when connectivity returns.
  useEffect(() => {
    let wasOnline = true;
    const unsub = NetInfo.addEventListener((state) => {
      const nowOnline = Boolean(state.isConnected && state.isInternetReachable !== false);
      setOnline(nowOnline);
      // Only on the offline -> online edge. NetInfo emits on every network
      // detail change (signal strength, SSID), and the old code kicked off
      // a sync for each one.
      if (nowOnline && !wasOnline) void sync({ userInitiated: true });
      wasOnline = nowOnline;
    });
    return unsub;
  }, [sync]);

  // Sync when the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => sub.remove();
  }, [sync]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  return (
    <SyncContext.Provider
      value={{
        dbReady,
        dbError,
        pendingCount,
        failedCount,
        syncing,
        lastSyncAt,
        lastSyncError,
        online,
        sync,
        refreshCounts,
        retryFailed,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used within SyncProvider");
  return ctx;
}
