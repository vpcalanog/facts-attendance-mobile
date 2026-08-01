import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { useSync } from "@/context/sync-context";

export default function SyncStatusBadge() {
  const { pendingCount, syncing, online, lastSyncError } = useSync();

  let label = online ? "Up to date" : "Offline";
  if (syncing) label = "Syncing…";
  else if (lastSyncError) label = "Sync error";
  else if (pendingCount > 0) label = `${pendingCount} pending`;

  const color = !online ? "#eab308" : lastSyncError ? "#ef4444" : pendingCount > 0 ? "#eab308" : "#22c55e";

  return (
    <View style={styles.row}>
      {syncing ? <ActivityIndicator size="small" /> : <View style={[styles.dot, { backgroundColor: color }]} />}
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 12, opacity: 0.8, color: "#fff" },
});
