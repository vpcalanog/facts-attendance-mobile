import CornerFlag from "@/components/corner-flag";
import SyncStatusBadge from "@/components/sync-status-badge";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const { sync, syncing, pendingCount, lastSyncAt, lastSyncError, online } = useSync();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <CornerFlag size={22} />
        <Text style={styles.name}>{user?.name || user?.username}</Text>
        <Text style={styles.meta}>@{user?.username}</Text>
        {user?.role ? <Text style={styles.role}>{user.role}</Text> : null}
      </View>

      <View style={styles.card}>
        <View style={styles.syncHeader}>
          <Text style={styles.label}>Sync status</Text>
          <SyncStatusBadge />
        </View>
        <Text style={styles.meta}>{online ? "Online" : "Offline"}</Text>
        <Text style={styles.meta}>{pendingCount} entries pending upload</Text>
        {lastSyncAt ? (
          <Text style={styles.meta}>
            Last synced {new Date(lastSyncAt).toLocaleTimeString()}
          </Text>
        ) : null}
        {lastSyncError ? <Text style={styles.error}>{lastSyncError}</Text> : null}
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={() => sync({ forceRoster: true, forceEvents: true })}
          disabled={syncing}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonTextDark}>{syncing ? "Syncing…" : "Sync now"}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.button, styles.logoutButton]}
        onPress={logout}
        activeOpacity={0.85}
      >
        <Text style={styles.buttonText}>Log out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, backgroundColor: BRAND.void, flexGrow: 1 },
  card: {
    backgroundColor: BRAND.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: BRAND.line,
    overflow: "hidden",
    gap: 4
  },
  name: { color: BRAND.bone, fontSize: 18, fontWeight: "800" },
  meta: { color: BRAND.smoke, fontSize: 13 },
  role: {
    color: BRAND.signal,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2,
    textTransform: "uppercase"
  },
  syncHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  label: { color: BRAND.bone, fontSize: 15, fontWeight: "700" },
  error: { color: BRAND.danger, fontSize: 12 },
  button: {
    backgroundColor: BRAND.signal,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 8,
    shadowColor: BRAND.signal,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3
  },
  secondaryButton: {
    backgroundColor: BRAND.surfaceRaised,
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 1,
    borderColor: BRAND.line
  },
  logoutButton: { backgroundColor: BRAND.crimsonDeep, borderColor: BRAND.crimson, borderWidth: 1 },
  buttonText: { color: BRAND.void, fontWeight: "800", fontSize: 15, letterSpacing: 0.5 },
  buttonTextDark: { color: BRAND.bone, fontWeight: "700", fontSize: 15 }
});
