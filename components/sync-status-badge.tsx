import { BRAND } from "@/constants/brand";
import { useSync } from "@/context/sync-context";
import React from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

export default function SyncStatusBadge() {
  const { pendingCount, failedCount, syncing, online, lastSyncError } = useSync();

  // Ordered by how much the staff member needs to know about it: a
  // refused entry is worse than a queued one, which is worse than simply
  // being offline (an expected, supported state for this app).
  let label: string;
  let color: string;
  if (syncing) {
    label = "Syncing…";
    color = BRAND.smoke;
  } else if (failedCount > 0) {
    label = `${failedCount} failed`;
    color = BRAND.danger;
  } else if (!online) {
    label = pendingCount > 0 ? `Offline · ${pendingCount} queued` : "Offline";
    color = BRAND.amber;
  } else if (lastSyncError) {
    label = "Sync error";
    color = BRAND.danger;
  } else if (pendingCount > 0) {
    label = `${pendingCount} pending`;
    color = BRAND.amber;
  } else {
    label = "Up to date";
    color = BRAND.green;
  }

  return (
    <View style={styles.row}>
      {syncing ? (
        <ActivityIndicator size="small" color={BRAND.smoke} />
      ) : (
        <View style={[styles.dot, { backgroundColor: color }]} />
      )}
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 12, color: BRAND.smoke },
});
