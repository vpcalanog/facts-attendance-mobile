import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { TouchableOpacity } from "react-native";

import FloatingEventNav from "@/components/floating-event-nav";
import { BRAND } from "@/constants/brand";
import { EventRow, getEvent, resolveEventId } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { log } from "@/lib/logger";

export default function EventLayout() {
  const params = useLocalSearchParams<{ eventId: string }>();
  const routeId = typeof params.eventId === "string" ? params.eventId : "";
  const router = useRouter();
  const [event, setEvent] = useState<EventRow | null>(null);
  // An event created offline is reached by a temporary id; once sync
  // reconciles it the row is renamed, so follow the rename rather than
  // leaving the nav pointing at an id that no longer exists.
  const [resolvedId, setResolvedId] = useState(routeId);

  useEffect(() => {
    let cancelled = false;
    if (!routeId) return;
    void (async () => {
      try {
        const id = await resolveEventId(routeId);
        const row = await getEvent(id);
        if (cancelled) return;
        setResolvedId(id);
        setEvent(row);
      } catch (err) {
        log.warn("couldn't load event for header", { message: toAppError(err).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId]);

  return (
    <>
      <Stack
        screenOptions={{
          headerShown: true,
          headerStyle: {
            backgroundColor: BRAND.void,
          },
          headerTintColor: BRAND.bone,
          headerBackTitle: "Back",
          headerTitle: event?.name || "Event",
          headerTitleAlign: "left",
          headerLeft: () => (
            <TouchableOpacity
              onPress={() => {
                // router.back() throws if there's no history to unwind —
                // e.g. this screen was entered directly via a deep link.
                if (router.canGoBack()) {
                  router.back();
                } else {
                  router.replace("/events");
                }
              }}
              style={{ paddingHorizontal: 12 }}
              hitSlop={8}
            >
              <Ionicons name="chevron-back" size={22} color={BRAND.bone} />
            </TouchableOpacity>
          ),
          contentStyle: { backgroundColor: BRAND.void },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Scan" }} />
        <Stack.Screen name="manual" options={{ title: "Manual" }} />
        <Stack.Screen name="logs" options={{ title: "Logs" }} />
      </Stack>

      {resolvedId ? <FloatingEventNav eventId={resolvedId} /> : null}
    </>
  );
}
