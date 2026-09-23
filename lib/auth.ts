import * as SecureStore from "expo-secure-store";
import { SERVER_URL, SESSION_TIMEOUT_MS } from "./config";
import { DEV_ACCOUNTS, DevAccount, findDevAccount, OFFLINE_AUTH_ENABLED } from "./dev-accounts";
import { AppError, toAppError } from "./errors";
import { baseHeaders, fetchWithTimeout, readBody } from "./http";
import { log } from "./logger";

const TOKEN_KEY = "facts_auth_token";
const USER_KEY = "facts_auth_user";

export interface StaffUser {
  id: string;
  username: string;
  name: string;
  role: string;
  /**
   * Officers are themselves students, so an account can carry the
   * cohort it belongs to. This drives the rule that an officer may not
   * register attendance for their own course and year level.
   *
   * All three are optional: an administrator account has none of them,
   * and is therefore unrestricted. When the server sends only
   * `studentNumber`, the app resolves the cohort from the local roster
   * instead — see hooks/use-officer-cohort.ts.
   */
  studentNumber?: string | null;
  course?: string | null;
  yearLevel?: string | null;
}

/**
 * The server hands back a single opaque bearer token with no refresh
 * token and no expiry hint, so the client cannot pre-emptively renew a
 * session. Expiry is therefore detected reactively: any 401 from any
 * endpoint routes through `setAuthFailureHandler` in api.ts and ends the
 * session once. If the backend later grows refresh tokens, this module is
 * the only place that needs to learn about them.
 */

// --- storage (defensive: SecureStore is unavailable on web and can throw
//     on a device whose keystore is in a bad state; neither should take
//     the whole app down with a blank screen) ---------------------------

async function readSecure(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (err) {
    log.warn("secure store read failed", { key, message: toAppError(err).message });
    return null;
  }
}

async function writeSecure(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function deleteSecure(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (err) {
    log.warn("secure store delete failed", { key, message: toAppError(err).message });
  }
}

// --- shape validation ------------------------------------------------

function parseUser(raw: unknown): StaffUser | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  // `id` and `username` are the two fields the app genuinely depends on:
  // id for detecting an account switch, username for attributing scans.
  if (typeof u.username !== "string" || !u.username) return null;
  const id = typeof u.id === "string" ? u.id : typeof u.id === "number" ? String(u.id) : null;
  if (!id) return null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return {
    id,
    username: u.username,
    name: typeof u.name === "string" ? u.name : u.username,
    role: typeof u.role === "string" ? u.role : "",
    // Tolerated as absent: an older server build simply leaves the
    // officer unrestricted on the client, and the server-side check
    // remains the authoritative one either way.
    studentNumber: str(u.studentNumber),
    course: str(u.course),
    yearLevel: str(u.yearLevel),
  };
}

// --- offline sign-in (temporary) --------------------------------------

/**
 * Marks a session minted from the bundled account table rather than by
 * the server. Prefixed so it can't be mistaken for a real token in
 * storage or in a log.
 */
const LOCAL_TOKEN_PREFIX = "local-dev:";

export function isLocalToken(token: string): boolean {
  return token.startsWith(LOCAL_TOKEN_PREFIX);
}

function toStaffUser(account: DevAccount): StaffUser {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    role: account.role,
    studentNumber: account.studentNumber,
    course: account.course,
    yearLevel: account.yearLevel,
  };
}

// --- public API ------------------------------------------------------

export async function login(credentials: {
  username: string;
  password: string;
}): Promise<StaffUser> {
  try {
    return await loginViaServer(credentials);
  } catch (err) {
    const e = toAppError(err);
    // Only ever stands in for a server we could not reach. A server that
    // answered and said no is authoritative — falling back there would
    // let the bundled table resurrect a revoked or altered account.
    const unreachable = e.kind === "network" || e.kind === "timeout" || e.kind === "server";
    if (!OFFLINE_AUTH_ENABLED || !unreachable) throw e;

    const account = findDevAccount(credentials.username, credentials.password);
    // No match: surface the server's own failure rather than a message
    // about the bundled table. "The server returned an unexpected
    // sign-in response" is the useful thing to see; "that isn't a
    // built-in account" would just be misleading.
    if (!account) throw e;

    const user = toStaffUser(account);
    await writeSecure(TOKEN_KEY, `${LOCAL_TOKEN_PREFIX}${user.username}`);
    await writeSecure(USER_KEY, JSON.stringify(user));
    log.warn("signed in against the bundled account table; the server was unreachable", {
      username: user.username,
    });
    return user;
  }
}

async function loginViaServer(credentials: {
  username: string;
  password: string;
}): Promise<StaffUser> {
  const { token, user } = await requestServerSession(credentials);
  await writeSecure(TOKEN_KEY, token);
  await writeSecure(USER_KEY, JSON.stringify(user));
  log.info("signed in", { username: user.username, role: user.role });
  return user;
}

/** Asks the server for a session without storing it. */
async function requestServerSession({
  username,
  password,
}: {
  username: string;
  password: string;
}): Promise<{ token: string; user: StaffUser }> {
  const res = await fetchWithTimeout(
    `${SERVER_URL}/api/auth/login`,
    {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ username, password }),
    },
    SESSION_TIMEOUT_MS
  );

  const { json, isJson } = await readBody(res);

  if (!res.ok) {
    const message =
      (isJson && typeof json?.error === "string" && json.error) ||
      (res.status === 401 || res.status === 403
        ? "Incorrect username or password."
        : isJson
          ? `Sign-in failed (${res.status}).`
          : "Couldn't reach the sign-in service. Check your connection.");
    throw new AppError(message, res.status === 401 || res.status === 403 ? "validation" : "server", {
      status: res.status,
    });
  }

  // Validate before storing. The old code wrote `data.token` straight into
  // SecureStore; when the server answered 200 with an unexpected shape it
  // threw an opaque native error, or stored a session that could never
  // authenticate anything.
  const token = isJson && typeof json?.token === "string" ? json.token : null;
  const user = isJson ? parseUser(json?.user) : null;
  if (!token || !user) {
    throw new AppError("The server returned an unexpected sign-in response.", "server", {
      status: res.status,
    });
  }

  return { token, user };
}

// --- upgrading a bundled session ---------------------------------------

/**
 * Told when a bundled session has been swapped for a server one, so the
 * auth context can show the server's account and mark the session
 * verified. The context registers itself at startup.
 */
type SessionUpgradeHandler = (user: StaffUser) => void | Promise<void>;
let onSessionUpgraded: SessionUpgradeHandler | null = null;

export function setSessionUpgradeHandler(fn: SessionUpgradeHandler | null): void {
  onSessionUpgraded = fn;
}

let upgrading: Promise<string> | null = null;

/**
 * Trades a bundled session for a real server token, signing in with the
 * same built-in credentials the officer used offline. Returns the token
 * to send.
 *
 * A bundled token means nothing to the server, and sending it would earn
 * a 401 that signs the officer out mid-event. Upgrading instead lets a
 * built-in account upload its scans as soon as the server is reachable,
 * with no sign-out and sign-in. The officer keeps their queue: the new
 * session has the same username, which the account-switch guard treats
 * as the same person.
 *
 * Concurrent callers share one attempt, so a sync pass that fires several
 * requests at once signs in once.
 */
export function upgradeLocalSession(): Promise<string> {
  if (!upgrading) {
    upgrading = doUpgradeLocalSession().finally(() => {
      upgrading = null;
    });
  }
  return upgrading;
}

async function doUpgradeLocalSession(): Promise<string> {
  const token = await getToken();
  if (!token) throw new AppError("Not signed in.", "auth");
  if (!isLocalToken(token)) return token;

  const username = token.slice(LOCAL_TOKEN_PREFIX.length).toLowerCase();
  const account = DEV_ACCOUNTS.find((a) => a.username.toLowerCase() === username);
  if (!account) {
    throw new AppError(
      "This built-in account is no longer available. Your scans are saved on this device — " +
        "sign out and back in to upload them.",
      "validation"
    );
  }

  let session: { token: string; user: StaffUser };
  try {
    session = await requestServerSession({
      username: account.username,
      password: account.password,
    });
  } catch (err) {
    const e = toAppError(err);
    // The server answered and refused: it has no such account, or a
    // different password for it. Not a dead session — the officer keeps
    // working offline, and their scans stay queued.
    if (e.kind === "validation") {
      throw new AppError(
        "The server doesn't recognise this built-in account, so nothing can be uploaded yet. " +
          "Your scans are saved on this device.",
        "validation",
        { status: e.status }
      );
    }
    throw e;
  }

  // The officer may have signed out while the request was in flight.
  // Storing the new token then would sign them straight back in.
  if ((await getToken()) !== token) {
    throw new AppError("The session changed while signing in.", "cancelled");
  }

  await writeSecure(TOKEN_KEY, session.token);
  await writeSecure(USER_KEY, JSON.stringify(session.user));
  log.info("upgraded a built-in session to a server session", {
    username: session.user.username,
  });
  try {
    await onSessionUpgraded?.(session.user);
  } catch (err) {
    log.warn("session upgrade handler failed", { message: toAppError(err).message });
  }
  return session.token;
}

export async function logout(): Promise<void> {
  await deleteSecure(TOKEN_KEY);
  await deleteSecure(USER_KEY);
}

export async function getToken(): Promise<string | null> {
  return readSecure(TOKEN_KEY);
}

export async function getStoredUser(): Promise<StaffUser | null> {
  const raw = await readSecure(USER_KEY);
  if (!raw) return null;
  try {
    return parseUser(JSON.parse(raw));
  } catch {
    // Corrupt entry: previously this threw out of the startup effect and
    // left the app on a permanently blank screen. Drop it and move on.
    log.warn("stored user was unreadable; clearing it");
    await deleteSecure(USER_KEY);
    return null;
  }
}

export type RestoreResult =
  /** Nothing stored — show the login screen. */
  | { status: "none" }
  /** Server confirmed the token is still good. */
  | { status: "verified"; user: StaffUser }
  /** Couldn't reach the server; trusting the local session. */
  | { status: "unverified"; user: StaffUser; reason: string }
  /** Server actively rejected the token; local session has been cleared. */
  | { status: "expired" };

/**
 * Called on app start to restore a session without forcing a fresh login
 * every time.
 *
 * The critical distinction — and the bug this replaces — is between "the
 * server says this token is invalid" and "I couldn't ask the server".
 * The old version signed the user out on *any* non-2xx, so a dead tunnel
 * (HTTP 404 from ngrok), a 502 or a deployment blip evicted a staff member
 * mid-event and, because signing back in also needs the server, left them
 * with no way back to a device holding unsynced scans. Only a genuine
 * 401/403 clears the session now.
 */
export async function restoreSession(): Promise<RestoreResult> {
  const [token, user] = await Promise.all([getToken(), getStoredUser()]);
  if (!token || !user) {
    // A token without a readable user (or vice versa) is not a usable
    // session; clear the stray half so we start clean.
    if (token || user) await logout();
    return { status: "none" };
  }

  if (isLocalToken(token)) {
    // There is nothing to verify a bundled session against, and asking
    // the server would only earn a 401 that signs the officer straight
    // back out. Reported as unverified so the profile screen keeps
    // saying the session hasn't been confirmed.
    return {
      status: "unverified",
      user,
      reason: "Signed in with a built-in account while the server is unavailable.",
    };
  }

  try {
    const res = await fetchWithTimeout(
      `${SERVER_URL}/api/auth/session`,
      { headers: baseHeaders(token) },
      SESSION_TIMEOUT_MS
    );

    if (res.status === 401 || res.status === 403) {
      await logout();
      log.info("stored session was rejected by the server");
      return { status: "expired" };
    }

    if (!res.ok) {
      log.warn("session check inconclusive", { status: res.status });
      return {
        status: "unverified",
        user,
        reason: `Server unavailable (HTTP ${res.status}).`,
      };
    }

    // If the server echoes a user back, prefer it — a role change should
    // take effect without making the staff member sign out and back in.
    const { json, isJson } = await readBody(res);
    const fresh = isJson ? parseUser(json?.user) : null;
    if (fresh && fresh.id === user.id) {
      await writeSecure(USER_KEY, JSON.stringify(fresh));
      return { status: "verified", user: fresh };
    }
    return { status: "verified", user };
  } catch (err) {
    const e = toAppError(err);
    log.warn("session check failed; trusting local session", { kind: e.kind });
    return { status: "unverified", user, reason: e.message };
  }
}
