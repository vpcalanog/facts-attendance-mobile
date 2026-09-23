import { setAuthFailureHandler } from "@/lib/api";
import type { StaffUser } from "@/lib/auth";
import * as authLib from "@/lib/auth";
import { SERVER_URL } from "@/lib/config";
import { DEV_ACCOUNTS } from "@/lib/dev-accounts";
import { getMeta, initDb, resetLocalData, setMeta } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { resetSyncBackoff } from "@/lib/sync";
import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

const LAST_USER_KEY = "last_user_id";
const LAST_USERNAME_KEY = "last_username";

interface AuthContextValue {
  user: StaffUser | null;
  /** True until the stored session has been restored (or ruled out). */
  checking: boolean;
  /** False when we restored a session but couldn't reach the server to
   *  confirm it — the app is usable, we just can't vouch for the token. */
  sessionVerified: boolean;
  /** Set when the session ended on its own (expired token, server 401)
   *  rather than by the user tapping Log out, so the login screen can say
   *  why they're looking at it. */
  signedOutReason: string | null;
  clearSignedOutReason: () => void;
  serverUrl: string;
  login: (args: { username: string; password: string }) => Promise<StaffUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Nothing in the local database is scoped per user, so a second staff
 * member signing in on the same handset would otherwise inherit the
 * first one's roster, events, logs and — worst of all — their unsynced
 * attendance queue, which would then upload under the new person's token.
 * Detect the switch and start clean.
 */
export async function handleAccountSwitch(user: StaffUser): Promise<void> {
  await initDb();
  const [previousId, previousUsername] = await Promise.all([
    getMeta(LAST_USER_KEY),
    getMeta(LAST_USERNAME_KEY),
  ]);
  const username = user.username.trim().toLowerCase();
  // The same officer can arrive under two ids: a bundled account's
  // `local-…` id while the server was down, then the server's own id. The
  // username is what they share. Comparing ids alone treated that as a
  // different person and erased every scan taken offline.
  const sameAccount =
    !previousId ||
    previousId === user.id ||
    previousUsername === username ||
    DEV_ACCOUNTS.some((a) => a.id === previousId && a.username.toLowerCase() === username);
  if (!sameAccount) {
    log.info("different account signing in; clearing local data");
    await resetLocalData();
  }
  await setMeta(LAST_USER_KEY, user.id);
  await setMeta(LAST_USERNAME_KEY, username);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StaffUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [sessionVerified, setSessionVerified] = useState(false);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const result = await authLib.restoreSession();
        if (!mounted.current) return;
        switch (result.status) {
          case "verified":
            await handleAccountSwitch(result.user);
            if (!mounted.current) return;
            setUser(result.user);
            setSessionVerified(true);
            break;
          case "unverified":
            // The server was unreachable, not hostile. Let the staff
            // member keep working offline against their cached data.
            await handleAccountSwitch(result.user);
            if (!mounted.current) return;
            setUser(result.user);
            setSessionVerified(false);
            break;
          case "expired":
            setSignedOutReason("Your session expired. Please sign in again.");
            break;
          case "none":
            break;
        }
      } catch (err) {
        // A throw here used to leave `checking` true forever — a blank
        // screen on every launch, unrecoverable without reinstalling.
        log.error("session restore failed", { message: toAppError(err).message });
      } finally {
        if (mounted.current) setChecking(false);
      }
    })();
  }, []);

  const login = useCallback(
    async ({ username, password }: { username: string; password: string }) => {
      const u = await authLib.login({ username, password });
      // Clear stale local data *before* exposing the new user, so the sync
      // engine never gets a chance to push the previous account's queue.
      await handleAccountSwitch(u);
      resetSyncBackoff();
      setSignedOutReason(null);
      setSessionVerified(true);
      setUser(u);
      return u;
    },
    []
  );

  const endSession = useCallback(async (reason: string | null) => {
    await authLib.logout();
    resetSyncBackoff();
    setUser(null);
    setSessionVerified(false);
    setSignedOutReason(reason);
  }, []);

  const logout = useCallback(async () => {
    await endSession(null);
  }, [endSession]);

  // One place handles an expired token for the whole app. Without this a
  // 401 just surfaced as "Request failed (401)" on every sync forever,
  // with no way back to a working session short of reinstalling.
  useEffect(() => {
    setAuthFailureHandler((reason) => {
      log.warn("server rejected our token; ending session");
      void endSession(reason || "Your session expired. Please sign in again.");
    });
    return () => setAuthFailureHandler(null);
  }, [endSession]);

  const clearSignedOutReason = useCallback(() => setSignedOutReason(null), []);

  return (
    <AuthContext.Provider
      value={{
        user,
        checking,
        sessionVerified,
        signedOutReason,
        clearSignedOutReason,
        serverUrl: SERVER_URL,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
