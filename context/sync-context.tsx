import { getPendingCount, initDb } from "@/lib/db";
import { runSync, SyncResult } from "@/lib/sync";
import NetInfo from "@react-native-community/netinfo";
import React, { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "./auth-context";

interface SyncContextValue {
  dbReady: boolean;
  pendingCount: number;
  syncing: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  online: boolean;
  sync: (opts?: { forceRoster?: boolean; forceEvents?: boolean }) => Promise<SyncResult | undefined>;
  refreshPendingCount: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);
const AUTO_SYNC_INTERVAL_MS = 60 * 1000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [dbReady, setDbReady] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const syncingRef = useRef(false);

  useEffect(() => {
    initDb().then(() => setDbReady(true));
  }, []);

  const refreshPendingCount = useCallback(async () => {
    if (!dbReady) return;
    setPendingCount(await getPendingCount());
  }, [dbReady]);

  const sync = useCallback(
    async (opts?: { forceRoster?: boolean; forceEvents?: boolean }) => {
      if (!dbReady || !user || syncingRef.current) return;
      syncingRef.current = true;
      setSyncing(true);
      const result = await runSync(opts);
      setOnline(result.online);
      if (result.error) {
        setLastSyncError(result.error);
      } else {
        setLastSyncError(null);
        setLastSyncAt(new Date().toISOString());
      }
      await refreshPendingCount();
      setSyncing(false);
      syncingRef.current = false;
      return result;
    },
    [dbReady, user, refreshPendingCount]
  );

  // Initial + periodic sync while foregrounded and logged in.
  useEffect(() => {
    if (!dbReady || !user) return;
    sync({ forceRoster: true, forceEvents: true });
    const interval = setInterval(() => sync(), AUTO_SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [dbReady, user, sync]);

  // Sync immediately when connectivity returns.
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      const isOnline = Boolean(state.isConnected && state.isInternetReachable !== false);
      setOnline(isOnline);
      if (isOnline) sync();
    });
    return unsub;
  }, [sync]);

  // Sync when the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") sync();
    });
    return () => sub.remove();
  }, [sync]);

  useEffect(() => {
    refreshPendingCount();
  }, [refreshPendingCount]);

  return (
    <SyncContext.Provider
      value={{ dbReady, pendingCount, syncing, lastSyncAt, lastSyncError, online, sync, refreshPendingCount }}
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
