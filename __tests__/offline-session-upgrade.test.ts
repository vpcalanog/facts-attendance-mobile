/**
 * An officer who signed in with a bundled account while the server was
 * down, scanned all morning, and is now meeting a server that is back.
 *
 * Two bugs chained here into silent loss of every offline scan: the
 * bundled token was sent to the server, whose 401 signed the officer out;
 * and signing back in with their real account carried a different user
 * id, which the account-switch guard read as a different person and wiped
 * the queue.
 */
jest.mock("expo-sqlite", () => require("./sqlite-mock").createExpoSqliteMock());

import { jsonResponse, setFetch } from "./helpers";

let STORE: Map<string, string>;

type Db = typeof import("@/lib/db");
type Api = typeof import("@/lib/api");
type Ctx = typeof import("@/context/auth-context");
type Accounts = typeof import("@/lib/dev-accounts");

let db: Db;
let api: Api;
let ctx: Ctx;
let accounts: Accounts;

beforeEach(async () => {
  jest.resetModules();
  // Re-required after the reset: the old instance holds a different store.
  STORE = require("expo-secure-store").__store;
  STORE.clear();
  db = require("@/lib/db");
  api = require("@/lib/api");
  ctx = require("@/context/auth-context");
  accounts = require("@/lib/dev-accounts");
  await db.initDb();
});

function bundled() {
  return accounts.DEV_ACCOUNTS.find((x) => x.username === "edictado")!;
}

const SERVER_USER = {
  id: "officer-S2025101493",
  username: "edictado",
  name: "Earl Joseph Cartabio Dictado",
  role: "officer",
  studentNumber: "S2025101493",
  course: "BSIT",
  yearLevel: "2nd Year",
};

/** A server that knows the officer and accepts whatever else is asked. */
function serverWithAccount() {
  return setFetch(
    jest.fn(async (url: string) =>
      url.endsWith("/api/auth/login")
        ? jsonResponse({ token: "real-token", user: SERVER_USER })
        : jsonResponse({ ok: true })
    )
  );
}

describe("requests from a bundled session", () => {
  beforeEach(() => {
    STORE.set("facts_auth_token", "local-dev:edictado");
    STORE.set("facts_auth_user", JSON.stringify({ ...bundled(), password: undefined }));
  });

  it("sign in to the server with the built-in account, then send the real token", async () => {
    const fetchSpy = serverWithAccount();

    await api.authFetch("/api/attendance/sync");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [loginUrl, loginInit] = fetchSpy.mock.calls[0];
    expect(loginUrl).toMatch(/\/api\/auth\/login$/);
    expect(JSON.parse(loginInit.body)).toEqual({
      username: "edictado",
      password: bundled().password,
    });
    const [, init] = fetchSpy.mock.calls[1];
    expect(init.headers.Authorization).toBe("Bearer real-token");
    expect(STORE.get("facts_auth_token")).toBe("real-token");
  });

  it("tell the app which server account it now holds", async () => {
    serverWithAccount();
    const onUpgrade = jest.fn();
    require("@/lib/auth").setSessionUpgradeHandler(onUpgrade);

    await api.authFetch("/api/attendance/sync");

    expect(onUpgrade).toHaveBeenCalledWith(expect.objectContaining({ id: SERVER_USER.id }));
  });

  it("sign in once when several requests start together", async () => {
    const fetchSpy = serverWithAccount();

    await Promise.all([api.authFetch("/api/events"), api.authFetch("/api/students")]);

    const logins = fetchSpy.mock.calls.filter(([url]) => url.endsWith("/api/auth/login"));
    expect(logins).toHaveLength(1);
  });

  it("keep the officer signed in when the server doesn't know the account", async () => {
    const fetchSpy = setFetch(
      jest.fn(async () => jsonResponse({ error: "Invalid username or password." }, { status: 401 }))
    );
    const onAuthFailure = jest.fn();
    api.setAuthFailureHandler(onAuthFailure);

    await expect(api.authFetch("/api/attendance/sync")).rejects.toThrow(/built-in account/);

    // Only the sign-in was attempted; the bundled token never went out.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(STORE.get("facts_auth_token")).toBe("local-dev:edictado");
  });

  it("stay queued as a transport failure while the server is unreachable", async () => {
    setFetch(
      jest.fn(async () => {
        throw new TypeError("Network request failed");
      })
    );

    await expect(api.authFetch("/api/attendance/sync")).rejects.toMatchObject({ kind: "network" });
    expect(STORE.get("facts_auth_token")).toBe("local-dev:edictado");
  });

  it("don't resurrect a session the officer signed out of mid-request", async () => {
    setFetch(
      jest.fn(async (url: string) => {
        if (url.endsWith("/api/auth/login")) STORE.delete("facts_auth_token");
        return jsonResponse({ token: "real-token", user: SERVER_USER });
      })
    );

    await expect(api.authFetch("/api/attendance/sync")).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(STORE.has("facts_auth_token")).toBe(false);
  });
});

describe("account switching", () => {
  it("keeps offline scans when the same officer signs in with their server account", async () => {
    await ctx.handleAccountSwitch(bundled());
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });

    await ctx.handleAccountSwitch({ id: "srv-42", username: "EDictado", name: "Earl", role: "officer" });

    await expect(db.getPendingCount()).resolves.toBe(1);
  });

  it("recognizes an install that recorded only the bundled id", async () => {
    // State written before usernames were recorded alongside the id.
    await db.setMeta("last_user_id", bundled().id);
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });

    await ctx.handleAccountSwitch({ id: "srv-42", username: "edictado", name: "Earl", role: "officer" });

    await expect(db.getPendingCount()).resolves.toBe(1);
  });

  it("still clears local data for a genuinely different officer", async () => {
    await ctx.handleAccountSwitch(bundled());
    await db.insertAttendance({ studentNumber: "S2012345678", eventId: "ev1" });

    await ctx.handleAccountSwitch({ id: "srv-99", username: "jmonzor", name: "J", role: "officer" });

    await expect(db.getPendingCount()).resolves.toBe(0);
  });
});
