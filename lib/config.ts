import Constants from "expo-constants";

// Resolution order, highest priority first:
//   1. EXPO_PUBLIC_SERVER_URL         — inlined at build time, so a dev
//                                       tunnel / staging / prod build can
//                                       differ without touching source.
//   2. app.json  extra.serverUrl      — per-build override via EAS profile.
//   3. The baked-in default below     — the reserved ngrok static domain.
//
// This is a public base URL, not a credential: it ships inside the bundle
// either way. Real secrets must never live here — the app only ever holds
// the bearer token the server hands it at sign-in.
const FALLBACK_SERVER_URL = "https://mumbling-easily-capricorn.ngrok-free.dev";

function readConfigured(): string {
  const fromEnv = process.env.EXPO_PUBLIC_SERVER_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();

  const extra = Constants.expoConfig?.extra as { serverUrl?: unknown } | undefined;
  if (typeof extra?.serverUrl === "string" && extra.serverUrl.trim()) {
    return extra.serverUrl.trim();
  }
  return FALLBACK_SERVER_URL;
}

function normalize(url: string): string {
  // A trailing slash would produce `//api/...` once a path is appended,
  // which some routers treat as a different (404ing) route.
  return url.replace(/\/+$/, "");
}

export const SERVER_URL = normalize(readConfigured());

/** True when the app is pointed at a plaintext origin. Only tolerated for
 *  local development — a bearer token must never cross the wire in clear. */
export const IS_INSECURE_SERVER =
  SERVER_URL.startsWith("http://") &&
  !/^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.|10\.)/.test(SERVER_URL);

/**
 * Kept as an async function (rather than exporting the constant directly
 * everywhere) so existing callers — restoreSession(), auth-context, etc. —
 * don't need to change how they read the server URL.
 */
export async function getServerUrl(): Promise<string> {
  return SERVER_URL;
}

/** How long any single request may take before we give up and let the
 *  offline-first path take over. Kept short for ordinary JSON calls so a
 *  dead tunnel doesn't wedge the UI; generous for the OCR image upload. */
export const REQUEST_TIMEOUT_MS = 15_000;
export const UPLOAD_TIMEOUT_MS = 45_000;
/** Session restore blocks the splash screen, so it gets the tightest budget. */
export const SESSION_TIMEOUT_MS = 8_000;
