import { useAuth } from "@/context/auth-context";
import { Redirect } from "expo-router";

/**
 * The entry route only decides where to send someone.
 *
 * It used to `router.replace("/login")` from an effect unconditionally,
 * which pushed an already-signed-in staff member at the login screen and
 * relied on Stack.Protected to bounce them back — a visible flash and a
 * pointless extra navigation on every cold start.
 */
export default function Index() {
  const { user, checking } = useAuth();

  // The root layout holds the splash while this is true.
  if (checking) return null;

  return <Redirect href={user ? "/events" : "/login"} />;
}
