// Deliberately tiny. Dev builds get readable breadcrumbs; production
// builds stay quiet so nothing sensitive ends up in device logs.
//
// Nothing here ever logs a token, a password or a full request body —
// callers pass short context objects, and `redact` strips the obvious
// offenders in case one slips through.

const SENSITIVE_KEYS = /^(token|password|authorization|imagebase64|secret)$/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 300) {
    return `${value.slice(0, 300)}…[${value.length} chars]`;
  }
  return value;
}

/** A ring buffer of recent events, surfaced in-app on the profile screen
 *  so a problem on a staff member's phone can be described over the phone
 *  without needing a debugger attached. */
const RECENT_LIMIT = 50;
const recent: { at: string; level: string; msg: string }[] = [];

function record(level: string, msg: string) {
  recent.push({ at: new Date().toISOString(), level, msg });
  if (recent.length > RECENT_LIMIT) recent.shift();
}

export function getRecentLogs() {
  return recent.slice().reverse();
}

export const log = {
  debug(msg: string, ctx?: unknown) {
    if (__DEV__) console.log(`[facts] ${msg}`, ctx === undefined ? "" : redact(ctx));
  },
  info(msg: string, ctx?: unknown) {
    record("info", msg);
    if (__DEV__) console.log(`[facts] ${msg}`, ctx === undefined ? "" : redact(ctx));
  },
  warn(msg: string, ctx?: unknown) {
    record("warn", msg);
    if (__DEV__) console.warn(`[facts] ${msg}`, ctx === undefined ? "" : redact(ctx));
  },
  error(msg: string, ctx?: unknown) {
    record("error", msg);
    // Kept in production too: a hard error is worth surfacing in a crash
    // report, and `redact` has already scrubbed the context.
    console.error(`[facts] ${msg}`, ctx === undefined ? "" : redact(ctx));
  },
};
