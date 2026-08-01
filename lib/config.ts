// The app talks to a single, fixed deployment behind a reserved ngrok
// static domain — so there's nothing for the user to type in on sign-in.
// If this ever needs to change (new tunnel, real domain, etc.), update it
// here only.
export const SERVER_URL = "https://mumbling-easily-capricorn.ngrok-free.dev";

/**
 * Kept as an async function (rather than exporting the constant directly
 * everywhere) so existing callers — restoreSession(), auth-context, etc. —
 * don't need to change how they read the server URL.
 */
export async function getServerUrl(): Promise<string> {
  return SERVER_URL;
}
