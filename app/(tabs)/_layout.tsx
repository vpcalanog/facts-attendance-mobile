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
          borderTopWidth: 1
        },
        headerStyle: {
          backgroundColor: BRAND.void,
          borderBottomColor: BRAND.line,
          borderBottomWidth: 1
        },
        headerTitle: () => <LogoMark size={26} withWordmark />,
        headerTitleAlign: "left"
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Scan",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="camera" size={size} color={color} />
          )
        }}
      />
      <Tabs.Screen
        name="manual"
        options={{
          title: "Manual",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="keypad" size={size} color={color} />
          )
        }}
      />
      <Tabs.Screen
        name="logs"
        options={{
          title: "Logs",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list" size={size} color={color} />
          )
        }}
      />
    </Tabs>
  );
}
