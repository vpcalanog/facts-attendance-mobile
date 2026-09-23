// A single error taxonomy for everything that crosses the network or the
// storage boundary. Screens and the sync engine both branch on `kind`
// rather than sniffing status codes or message text, so "the token
// expired", "the tunnel is down" and "the server rejected this row" stay
// distinguishable all the way up to the UI.

export type ErrorKind =
  | "network" // couldn't reach the server at all
  | "timeout" // reached it (maybe) but it never answered in time
  | "auth" // 401/403 — the session is no longer good
  | "validation" // 4xx the user could conceivably fix
  | "server" // 5xx / malformed response — not our fault, retry later
  | "cancelled" // we aborted it on purpose (navigation, newer request)
  | "unknown";

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | null;
  /** Whether a later, identical attempt could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    message: string,
    kind: ErrorKind,
    { status = null, retryable }: { status?: number | null; retryable?: boolean } = {}
  ) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable ?? defaultRetryable(kind);
  }
}

function defaultRetryable(kind: ErrorKind): boolean {
  switch (kind) {
    case "network":
    case "timeout":
    case "server":
      return true;
    // An expired session, a rejected payload or a deliberate cancel will
    // all fail again in exactly the same way if we just try harder.
    case "auth":
    case "validation":
    case "cancelled":
      return false;
    default:
      return false;
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof AppError && err.kind === "auth";
}

export function isCancelled(err: unknown): boolean {
  return (
    (err instanceof AppError && err.kind === "cancelled") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** Wraps anything thrown into an AppError so callers only handle one type. */
export function toAppError(err: unknown, fallback = "Something went wrong."): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError") return new AppError("Request cancelled.", "cancelled");
    return new AppError(err.message || fallback, "unknown");
  }
  return new AppError(fallback, "unknown");
}

/** Short, non-technical text safe to put in front of a staff member. */
export function userMessage(err: unknown): string {
  const e = toAppError(err);
  switch (e.kind) {
    case "network":
      return "No connection to the server. Your work is saved on this device.";
    case "timeout":
      return "The server took too long to respond. Your work is saved on this device.";
    case "auth":
      return "Your session expired. Please sign in again.";
    case "server":
      return "The server had a problem. We'll retry automatically.";
    default:
      return e.message;
  }
}
