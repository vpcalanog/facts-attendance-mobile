import { getToken } from "./auth";
import { getServerUrl } from "./config";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function authFetch(pathName: string, options: RequestInit = {}): Promise<any> {
  const [token, base] = await Promise.all([getToken(), getServerUrl()]);
  if (!base) throw new ApiError("No server configured.", 0);

  const res = await fetch(`${base}${pathName}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}
