import type { StaffUser } from "@/lib/auth";
import * as authLib from "@/lib/auth";
import { SERVER_URL } from "@/lib/config";
import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState
} from "react";

interface AuthContextValue {
  user: StaffUser | null;
  checking: boolean;
  serverUrl: string;
  login: (args: { username: string; password: string }) => Promise<StaffUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<StaffUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const restored = await authLib.restoreSession();
      setUser(restored);
      setChecking(false);
    })();
  }, []);

  const login = useCallback(
    async ({ username, password }: { username: string; password: string }) => {
      const u = await authLib.login({ username, password });
      setUser(u);
      return u;
    },
    []
  );

  const logout = useCallback(async () => {
    await authLib.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, checking, serverUrl: SERVER_URL, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
