import { AppError, ErrorKind } from "./errors";

// Shared transport primitives. Lives apart from `api.ts` so `auth.ts` can
// use the same timeout/parsing rules for the two unauthenticated endpoints
// (login, session) without importing `api.ts` and creating a cycle —
// api.ts already depends on auth.ts for the bearer token.

export function kindForStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  if (status >= 400) return "validation";
  return "unknown";
}

/**
 * `fetch` with a hard deadline and optional caller cancellation.
 * React Native's fetch honours `signal` but has no timeout of its own, and
 * without one a half-open socket leaves the promise pending forever —
 * which is what wedges a sync loop or pins the splash screen on startup.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal | null
): Promise<Response> {
  // Already given up before we even started (the screen unmounted while
  // the bearer token was being read): don't open a socket at all.
  if (external?.aborted) throw new AppError("Request cancelled.", "cancelled");

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const relayAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", relayAbort);
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    if (timedOut) {
      throw new AppError(
        `The server didn't respond within ${Math.round(timeoutMs / 1000)}s.`,
        "timeout"
      );
    }
    if (external?.aborted) throw new AppError("Request cancelled.", "cancelled");
    // A genuine transport failure: DNS, refused connection, tunnel down.
    throw new AppError("Couldn't reach the server.", "network");
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", relayAbort);
  }
}

/**
 * Reads a body defensively. The server is expected to speak JSON, but a
 * dead tunnel, a proxy error page or a captive portal all happily return
 * HTML — and blindly calling `res.json()` on that is what produced the old
 * uninformative "Request failed (404)".
 */
export async function readBody(
  res: Response
): Promise<{ json: any; raw: string; isJson: boolean }> {
  const raw = await res.text().catch(() => "");
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) return { json: null, raw, isJson: false };
  try {
    return { json: raw ? JSON.parse(raw) : {}, raw, isJson: true };
  } catch {
    return { json: null, raw, isJson: false };
  }
}

/** Headers every request to the API carries. */
export function baseHeaders(token?: string | null): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    // Suppresses ngrok's HTML interstitial on free tunnels, which would
    // otherwise masquerade as a malformed API response.
    "ngrok-skip-browser-warning": "1",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
