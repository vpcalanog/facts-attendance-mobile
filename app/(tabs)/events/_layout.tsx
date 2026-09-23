import LogoMark from "@/components/logo-mark";
import { BRAND } from "@/constants/brand";
import { Stack } from "expo-router";
import React from "react";

export default function EventsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: BRAND.void,
        },
        headerTintColor: BRAND.bone,
        headerBackTitle: "Back",
        contentStyle: { backgroundColor: BRAND.void },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          headerTitle: () => <LogoMark size={26} withWordmark />,
          headerTitleAlign: "left",
        }}
      />
      <Stack.Screen name="[eventId]" options={{ headerShown: false }} />
    </Stack>
  );
}
