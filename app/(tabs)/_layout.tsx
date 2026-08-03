import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import React from "react";

import { HapticTab } from "@/components/haptic-tab";
import LogoMark from "@/components/logo-mark";
import { BRAND } from "@/constants/brand";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: BRAND.signal,
        tabBarInactiveTintColor: BRAND.smoke,
        tabBarStyle: {
          backgroundColor: BRAND.surface,
          borderTopColor: BRAND.line,
          borderTopWidth: 1,
        },
        headerStyle: {
          backgroundColor: BRAND.void,
          borderBottomColor: BRAND.line,
          borderBottomWidth: 1,
        },
        headerTitle: () => <LogoMark size={26} withWordmark />,
        headerTitleAlign: "left",
      }}
    >
      <Tabs.Screen
        name="events"
        options={{
          title: "Events",
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: "Profile",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
