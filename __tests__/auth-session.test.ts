import * as SecureStore from "expo-secure-store";
import { htmlResponse, jsonResponse, setFetch } from "./helpers";

import { getStoredUser, getToken, login, restoreSession } from "@/lib/auth";

const TOKEN_KEY = "facts_auth_token";
const USER_KEY = "facts_auth_user";

const STORE = (SecureStore as unknown as { __store: Map<string, string> }).__store;

const USER = { id: "u1", username: "amabini", name: "A. Mabini", role: "admin" };

function seedSession() {
  STORE.set(TOKEN_KEY, "tok-123");
  STORE.set(USER_KEY, JSON.stringify(USER));
}

beforeEach(() => {
  STORE.clear();
});

describe("restoreSession", () => {
  it("reports no session when nothing is stored", async () => {
    setFetch(jest.fn());
    await expect(restoreSession()).resolves.toEqual({ status: "none" });
  });

  // The regression this whole change set exists for. The production
  // tunnel answers 404 with an HTML error page when it is down; the old
  // implementation treated any non-2xx as "token rejected", wiped the
  // session, and stranded a device holding unsynced scans behind a login
  // screen that also needed the server.
  it("keeps the session when the server is unreachable (404 HTML from a dead tunnel)", async () => {
    seedSession();
    setFetch(jest.fn(async () => htmlResponse(404)));

    const result = await restoreSession();

    expect(result.status).toBe("unverified");
    expect(result).toMatchObject({ user: { username: "amabini" } });
    await expect(getToken()).resolves.toBe("tok-123");
    await expect(getStoredUser()).resolves.toMatchObject({ username: "amabini" });
  });

  it("keeps the session on a 500", async () => {
    seedSession();
    setFetch(jest.fn(async () => jsonResponse({ error: "boom" }, { status: 500 })));

    await expect(restoreSession()).resolves.toMatchObject({ status: "unverified" });
    await expect(getToken()).resolves.toBe("tok-123");
  });

  it("keeps the session when the request throws outright", async () => {
    seedSession();
    setFetch(jest.fn(async () => {
      throw new TypeError("Network request failed");
    }));

    await expect(restoreSession()).resolves.toMatchObject({ status: "unverified" });
    await expect(getToken()).resolves.toBe("tok-123");
  });

  it("clears the session only when the server actually rejects the token", async () => {
    seedSession();
    setFetch(jest.fn(async () => jsonResponse({ error: "expired" }, { status: 401 })));

    await expect(restoreSession()).resolves.toEqual({ status: "expired" });
    await expect(getToken()).resolves.toBeNull();
    await expect(getStoredUser()).resolves.toBeNull();
  });

  it("adopts a fresh user object when the server echoes one back", async () => {
    seedSession();
    setFetch(jest.fn(async () => jsonResponse({ user: { ...USER, role: "staff" } })));

    const result = await restoreSession();

    expect(result).toMatchObject({ status: "verified", user: { role: "staff" } });
    // A role change must survive to the next launch, not just this one.
    await expect(getStoredUser()).resolves.toMatchObject({ role: "staff" });
  });

  it("recovers from a corrupt stored user instead of throwing", async () => {
    STORE.set(TOKEN_KEY, "tok-123");
    STORE.set(USER_KEY, "{not json");
    setFetch(jest.fn());

    // Previously this threw out of the startup effect, leaving `checking`
    // true forever and the app on a blank screen.
    await expect(restoreSession()).resolves.toEqual({ status: "none" });
  });

  it("discards a token with no matching user", async () => {
    STORE.set(TOKEN_KEY, "tok-123");
    setFetch(jest.fn());

    await expect(restoreSession()).resolves.toEqual({ status: "none" });
    await expect(getToken()).resolves.toBeNull();
  });
});

describe("login", () => {
  it("stores the token and user on success", async () => {
    setFetch(jest.fn(async () => jsonResponse({ token: "tok-abc", user: USER })));

    await expect(login({ username: "amabini", password: "pw" })).resolves.toMatchObject({
      username: "amabini",
    });
    await expect(getToken()).resolves.toBe("tok-abc");
  });

  it("refuses a 200 response that is missing a token, storing nothing", async () => {
    setFetch(jest.fn(async () => jsonResponse({ user: USER })));

    await expect(login({ username: "amabini", password: "pw" })).rejects.toThrow(
      /unexpected sign-in response/i
    );
    // The old code wrote `undefined` into SecureStore here.
    await expect(getToken()).resolves.toBeNull();
  });

  it("reports bad credentials in plain language", async () => {
    setFetch(jest.fn(async () => jsonResponse({}, { status: 401 })));

    await expect(login({ username: "amabini", password: "nope" })).rejects.toThrow(
      /incorrect username or password/i
    );
  });
});
