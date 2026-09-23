import { authFetch, setAuthFailureHandler } from "@/lib/api";
import { AppError } from "@/lib/errors";
import * as SecureStore from "expo-secure-store";
import { hangingFetch, htmlResponse, jsonResponse, setFetch } from "./helpers";

const STORE = (SecureStore as unknown as { __store: Map<string, string> }).__store;

beforeEach(() => {
  STORE.clear();
  STORE.set("facts_auth_token", "tok-123");
  setAuthFailureHandler(null);
});

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof AppError ? err.kind : "not-an-app-error";
  }
}

describe("authFetch", () => {
  it("sends the bearer token and parses JSON", async () => {
    const f = setFetch(jest.fn(async () => jsonResponse({ events: [1, 2] })));

    await expect(authFetch("/api/events")).resolves.toEqual({ events: [1, 2] });

    const headers = f.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("classifies a 401 as auth and notifies the session handler exactly once", async () => {
    const onAuthFailure = jest.fn();
    setAuthFailureHandler(onAuthFailure);
    setFetch(jest.fn(async () => jsonResponse({ error: "token expired" }, { status: 401 })));

    await expect(kindOf(authFetch("/api/events"))).resolves.toBe("auth");
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledWith("token expired");
  });

  it("does not sign the user out for a 401 raised during sign-in", async () => {
    const onAuthFailure = jest.fn();
    setAuthFailureHandler(onAuthFailure);
    setFetch(jest.fn(async () => jsonResponse({}, { status: 401 })));

    await expect(kindOf(authFetch("/api/x", { skipAuthFailureHandler: true }))).resolves.toBe(
      "auth"
    );
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  // A dead ngrok tunnel answers 404 with HTML. Read as an API 404 that is
  // "the request was wrong"; read correctly it is "the server is gone",
  // which is retryable and must not be blamed on the caller.
  it("treats an HTML error page as infrastructure, not a bad request", async () => {
    setFetch(jest.fn(async () => htmlResponse(404)));

    const err = await authFetch("/api/events").catch((e) => e as AppError);

    expect(err.kind).toBe("server");
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/server may be offline/i);
  });

  it("rejects a 200 that isn't JSON rather than treating it as empty data", async () => {
    // This is what protected the roster: an HTML 200 parsed as `{}` would
    // have produced `students: []` and wiped every student on the device.
    setFetch(jest.fn(async () => htmlResponse(200)));

    await expect(kindOf(authFetch("/api/students"))).resolves.toBe("server");
  });

  it("gives up on a hung request instead of waiting forever", async () => {
    jest.useFakeTimers();
    setFetch(hangingFetch());

    const promise = authFetch("/api/events", { timeoutMs: 5000 });
    const settled = kindOf(promise);
    await jest.advanceTimersByTimeAsync(5001);

    await expect(settled).resolves.toBe("timeout");
    jest.useRealTimers();
  });

  it("reports a caller-cancelled request as cancelled, not as a failure", async () => {
    setFetch(hangingFetch());
    const controller = new AbortController();

    const settled = kindOf(authFetch("/api/events", { signal: controller.signal }));
    controller.abort();

    await expect(settled).resolves.toBe("cancelled");
  });

  it("reports a transport failure as a network error", async () => {
    setFetch(
      jest.fn(async () => {
        throw new TypeError("Network request failed");
      })
    );

    await expect(kindOf(authFetch("/api/events"))).resolves.toBe("network");
  });
});
