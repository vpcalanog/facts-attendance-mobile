import * as SecureStore from "expo-secure-store";
import { SERVER_URL, getServerUrl } from "./config";

const TOKEN_KEY = "facts_auth_token";
const USER_KEY = "facts_auth_user";

export interface StaffUser {
  id: string;
  username: string;
  name: string;
  role: string;
}

export async function login({
  username,
  password
}: {
  username: string;
  password: string;
}): Promise<StaffUser> {
  const res = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Login failed.");
  }
  await SecureStore.setItemAsync(TOKEN_KEY, data.token);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(data.user));
  return data.user as StaffUser;
}

export async function logout(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}

export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function getStoredUser(): Promise<StaffUser | null> {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  return raw ? (JSON.parse(raw) as StaffUser) : null;
}

// Called on app start to restore a session without forcing a fresh login
// every time. Verifies the stored token against the server; falls back to
// trusting the locally stored session if there's no signal, rather than
// locking a staff member out of a kiosk that's mid-scan with no wifi.
export async function restoreSession(): Promise<StaffUser | null> {
  const [token, user, serverUrl] = await Promise.all([
    getToken(),
    getStoredUser(),
    getServerUrl()
  ]);
  if (!token || !user || !serverUrl) return null;

  try {
    const res = await fetch(`${serverUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      await logout();
      return null;
    }
    return user;
  } catch {
    return user;
  }
}
