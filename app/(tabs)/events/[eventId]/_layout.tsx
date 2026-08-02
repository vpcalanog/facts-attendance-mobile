import { Ionicons } from "@expo/vector-icons";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { TouchableOpacity } from "react-native";

import FloatingEventNav from "@/components/floating-event-nav";
import { BRAND } from "@/constants/brand";
import { EventRow, getEvent } from "@/lib/db";

export default function EventLayout() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const router = useRouter();
  const [event, setEvent] = useState<EventRow | null>(null);

  useEffect(() => {
    if (!eventId) return;
    getEvent(eventId).then(setEvent);
  }, [eventId]);

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

      {eventId ? <FloatingEventNav eventId={eventId} /> : null}
    </>
  );
}
