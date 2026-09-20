import { getToken } from "./auth";
import { getServerUrl, REQUEST_TIMEOUT_MS } from "./config";
import { AppError } from "./errors";
import { baseHeaders, fetchWithTimeout, kindForStatus, readBody } from "./http";
import { log } from "./logger";

/**
 * Called whenever the server tells us the bearer token is no longer good.
 * The auth context registers itself here at startup so a 401 anywhere —
 * a background sync, an OCR upload — tears the session down once, in one
 * place, instead of each caller inventing its own handling.
 */
type AuthFailureHandler = (reason: string) => void;
let onAuthFailure: AuthFailureHandler | null = null;

export function setAuthFailureHandler(fn: AuthFailureHandler | null): void {
  onAuthFailure = fn;
}

export interface FetchOptions extends Omit<RequestInit, "signal"> {
  /** Aborts the request when this signal fires (screen unmounted, a newer
   *  request superseded this one). Combined with the internal timeout. */
  signal?: AbortSignal | null;
  timeoutMs?: number;
  /** Set for sign-in, where a 401 means "wrong password" rather than
   *  "your session died" and must not trigger a global sign-out. */
  skipAuthFailureHandler?: boolean;
}

export async function authFetch<T = any>(
  pathName: string,
  options: FetchOptions = {}
): Promise<T> {
  const { signal, timeoutMs = REQUEST_TIMEOUT_MS, skipAuthFailureHandler, ...init } = options;
  const [token, base] = await Promise.all([getToken(), getServerUrl()]);
  if (!base) throw new AppError("No server configured.", "validation");

  const started = Date.now();
  const res = await fetchWithTimeout(
    `${base}${pathName}`,
    { ...init, headers: { ...baseHeaders(token), ...(init.headers || {}) } },
    timeoutMs,
    signal
  );

  const { json, isJson, raw } = await readBody(res);

  if (!res.ok) {
    // A non-JSON error body means we reached something that isn't the API
    // — a dead tunnel, a proxy, a captive portal. That is infrastructure
    // and worth retrying, even when it arrives dressed as a 404, so don't
    // let the status code alone classify it as the caller's fault.
    const kind = !isJson && res.status !== 401 && res.status !== 403
      ? "server"
      : kindForStatus(res.status);
    const serverMessage = isJson && typeof json?.error === "string" ? json.error : null;
    const message =
      serverMessage ??
      (isJson
        ? `Request failed (${res.status}).`
        : // A non-JSON error body is almost always infrastructure rather
          // than the API itself — say so instead of blaming the request.
          `Couldn't reach the API (HTTP ${res.status}). The server may be offline.`);

    log.warn("api request failed", {
      path: pathName,
      status: res.status,
      ms: Date.now() - started,
      kind,
    });

    if (kind === "auth" && !skipAuthFailureHandler) onAuthFailure?.(message);
    throw new AppError(message, kind, { status: res.status });
  }

  if (!isJson) {
    // 200 OK with an HTML body means we are not talking to the API. Treat
    // it as unreachable rather than as empty data — "empty data" would
    // otherwise wipe the local roster on the next replaceRoster().
    log.warn("api returned non-json on success", {
      path: pathName,
      preview: raw.slice(0, 120),
    });
    throw new AppError("The server returned an unexpected response.", "server", {
      status: res.status,
    });
  }

  return json as T;
}
