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

describe("requests from a bundled session", () => {
  it("never reach the server, and never end the session", async () => {
    STORE.set("facts_auth_token", "local-dev:edictado");
    const fetchSpy = setFetch(jest.fn(async () => jsonResponse({}, { status: 401 })));
    const onAuthFailure = jest.fn();
    api.setAuthFailureHandler(onAuthFailure);

    await expect(api.authFetch("/api/attendance/sync")).rejects.toThrow(/built-in account/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onAuthFailure).not.toHaveBeenCalled();
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
