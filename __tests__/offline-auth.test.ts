/**
 * Sign-in against the bundled account table, used while the backend has
 * no accounts yet.
 *
 * The behaviour that matters is the boundary: it must stand in for a
 * server that cannot be reached, and must never override one that
 * answered. Otherwise the table would outlive its purpose and resurrect
 * accounts the server has since changed or revoked.
 */
import * as SecureStore from "expo-secure-store";
import { htmlResponse, jsonResponse, setFetch } from "./helpers";

import { getStoredUser, getToken, login, restoreSession } from "@/lib/auth";
import { DEV_ACCOUNTS, findDevAccount, OFFLINE_AUTH_ENABLED } from "@/lib/dev-accounts";

const STORE = (SecureStore as unknown as { __store: Map<string, string> }).__store;

// A real officer from lib/Officers.csv: BSIT 2nd Year.
const ACCOUNT = DEV_ACCOUNTS.find((a) => a.username === "edictado")!;

function networkFailure() {
  return jest.fn(async () => {
    throw new TypeError("Network request failed");
  });
}

beforeEach(() => {
  STORE.clear();
});

describe("the bundled account table", () => {
  it("is enabled under test, and carries every officer", () => {
    expect(OFFLINE_AUTH_ENABLED).toBe(true);
    expect(DEV_ACCOUNTS).toHaveLength(27);
  });

  it("gives every account the cohort the restriction needs", () => {
    // Without course and year level on the session, the same-cohort rule
    // silently does nothing — which is the state the real server is in.
    for (const a of DEV_ACCOUNTS) {
      expect(a.course).toBeTruthy();
      expect(a.yearLevel).toBeTruthy();
      expect(a.studentNumber).toMatch(/^S20\d{8}$/);
    }
  });

  it("issues 8-character alphanumeric passwords with no confusable glyphs", () => {
    for (const a of DEV_ACCOUNTS) {
      expect(a.password).toMatch(/^[A-Za-z2-9]{8}$/);
      expect(a.password).not.toMatch(/[0O1lI]/);
    }
  });

  it("has no duplicate usernames or passwords", () => {
    expect(new Set(DEV_ACCOUNTS.map((a) => a.username)).size).toBe(27);
    expect(new Set(DEV_ACCOUNTS.map((a) => a.password)).size).toBe(27);
  });

  it("matches the username case-insensitively but the password exactly", () => {
    expect(findDevAccount(ACCOUNT.username.toUpperCase(), ACCOUNT.password)).toBeTruthy();
    expect(findDevAccount(ACCOUNT.username, ACCOUNT.password.toUpperCase())).toBeNull();
    expect(findDevAccount(ACCOUNT.username, "wrong")).toBeNull();
  });
});

describe("login falls back only when the server is unreachable", () => {
  it("signs in from the table when the request fails outright", async () => {
    setFetch(networkFailure());

    const user = await login({
      username: ACCOUNT.username,
      password: ACCOUNT.password,
    });

    expect(user).toMatchObject({
      username: "edictado",
      role: "officer",
      course: "BSIT",
      yearLevel: "2nd Year",
    });
    // Marked so it can never be mistaken for a server-issued token.
    await expect(getToken()).resolves.toBe("local-dev:edictado");
  });

  it("signs in from the table when the tunnel is down (404 HTML)", async () => {
    setFetch(jest.fn(async () => htmlResponse(404)));

    await expect(
      login({ username: ACCOUNT.username, password: ACCOUNT.password })
    ).resolves.toMatchObject({ username: "edictado" });
  });

  /**
   * The important negative case. Once the backend is seeded it becomes
   * the authority, and a rejected password must stay rejected.
   */
  it("does not override a server that answered and refused", async () => {
    setFetch(jest.fn(async () => jsonResponse({ error: "no such user" }, { status: 401 })));

    // The server's own explanation is preserved, and crucially no
    // bundled session is minted behind its back.
    await expect(
      login({ username: ACCOUNT.username, password: ACCOUNT.password })
    ).rejects.toThrow(/no such user/i);
    await expect(getToken()).resolves.toBeNull();
  });

  it("prefers the server when it answers successfully", async () => {
    setFetch(
      jest.fn(async () =>
        jsonResponse({
          token: "real-token",
          user: { id: "srv-1", username: "edictado", name: "Earl", role: "officer" },
        })
      )
    );

    await login({ username: ACCOUNT.username, password: ACCOUNT.password });

    await expect(getToken()).resolves.toBe("real-token");
  });

  it("rejects a bad password even with the server down", async () => {
    setFetch(networkFailure());

    // Reports the server's own failure rather than hinting at the
    // bundled table, which would be misleading when the real problem is
    // that nothing could be reached.
    await expect(
      login({ username: ACCOUNT.username, password: "not-the-password" })
    ).rejects.toThrow(/couldn't reach the server/i);
    await expect(getToken()).resolves.toBeNull();
  });
});

describe("restoring a bundled session", () => {
  it("restores without calling the server, and reports it as unverified", async () => {
    setFetch(networkFailure());
    await login({ username: ACCOUNT.username, password: ACCOUNT.password });

    // A session check would only earn a 401 that signs the officer
    // straight back out, so it must not be attempted.
    const probe = setFetch(jest.fn());
    const result = await restoreSession();

    expect(probe).not.toHaveBeenCalled();
    expect(result.status).toBe("unverified");
    expect(result).toMatchObject({ user: { username: "edictado", course: "BSIT" } });
  });

  it("keeps the cohort across a restart, so the rule survives", async () => {
    setFetch(networkFailure());
    await login({ username: ACCOUNT.username, password: ACCOUNT.password });

    await expect(getStoredUser()).resolves.toMatchObject({
      course: "BSIT",
      yearLevel: "2nd Year",
      studentNumber: "S2025101493",
    });
  });
});
