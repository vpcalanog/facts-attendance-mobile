import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router/react-navigation";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import "react-native-reanimated";

import ErrorBoundary from "@/components/error-boundary";
import { AuthProvider, useAuth } from "@/context/auth-context";
import { SyncProvider } from "@/context/sync-context";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { IS_INSECURE_SERVER, SERVER_URL } from "@/lib/config";
import { log } from "@/lib/logger";
import { GestureHandlerRootView } from "react-native-gesture-handler";

// Keep the splash up until fonts have loaded and the stored session has
// been resolved, so a signed-in staff member never sees a blank frame or
// a flash of the login screen on a cold start.
void SplashScreen.preventAutoHideAsync().catch(() => {});

function RootLayoutNav() {
  const { user, checking } = useAuth();

  useEffect(() => {
    if (!checking) void SplashScreen.hideAsync().catch(() => {});
  }, [checking]);

  // Don't render either branch until we know whether there's a session.
  if (checking) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [loaded, fontError] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
  });

  useEffect(() => {
    if (fontError) log.warn("font failed to load; continuing with system fonts");
  }, [fontError]);

  useEffect(() => {
    // The bearer token goes out on every request; over plaintext it is
    // readable by anyone on the same network. Worth shouting about if a
    // build is ever pointed at a non-local http:// origin.
    if (IS_INSECURE_SERVER) {
      log.error("server URL is not https — auth tokens would be sent in the clear", {
        serverUrl: SERVER_URL,
      });
    }
  }, []);

  // Previously only `loaded` was checked, so a font that failed to load
  // left the app on a permanent blank screen. A missing typeface is not a
  // reason to withhold the attendance app.
  if (!loaded && !fontError) {
    return null;
  }

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
          <AuthProvider>
            <SyncProvider>
              <RootLayoutNav />
              {/* The app runs on a single warm-black brand theme regardless of
                  system scheme, so status bar content stays light throughout. */}
              <StatusBar style="light" />
            </SyncProvider>
          </AuthProvider>
        </ThemeProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
