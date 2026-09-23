import SyncStatusBadge from "@/components/sync-status-badge";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import { SERVER_URL } from "@/lib/config";
import React, { useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

export default function ProfileScreen() {
  const { user, logout, sessionVerified } = useAuth();
  const {
    sync,
    syncing,
    pendingCount,
    failedCount,
    lastSyncAt,
    lastSyncError,
    online,
    retryFailed,
  } = useSync();
  const [retrying, setRetrying] = useState(false);

  function confirmLogout() {
    // Logging out is destructive in a way that isn't obvious: the queue
    // survives, but nobody else can upload it, and if this device is the
    // only copy of a morning's scans that matters. Say so before doing it.
    const queued = pendingCount + failedCount;
    if (queued > 0) {
      Alert.alert(
        "Log out with unsent scans?",
        `${queued} attendance ${queued === 1 ? "entry has" : "entries have"} not reached the server yet. ` +
          `They stay saved on this device, but they can only be uploaded by signing back in as ${user?.username}. ` +
          `Signing in as someone else will erase them.`,
        [
          { text: "Stay signed in", style: "cancel" },
          { text: "Log out anyway", style: "destructive", onPress: () => void logout() },
        ]
      );
      return;
    }
    Alert.alert("Log out?", "You'll need your username and password to sign back in.", [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => void logout() },
    ]);
  }

  async function onRetryFailed() {
    setRetrying(true);
    try {
      await retryFailed();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Text style={styles.name}>{user?.name || user?.username}</Text>
        <Text style={styles.meta}>@{user?.username}</Text>
        {user?.role ? <Text style={styles.role}>{user.role}</Text> : null}
        {!sessionVerified ? (
          <Text style={styles.warn}>
            Working offline — this session hasn&apos;t been confirmed with the server yet.
          </Text>
        ) : null}
      </View>

      <View style={styles.card}>
        <View style={styles.syncHeader}>
          <Text style={styles.label}>Sync status</Text>
          <SyncStatusBadge />
        </View>
        <Text style={styles.meta}>{online ? "Online" : "Offline"}</Text>
        <Text style={styles.meta}>{pendingCount} entries pending upload</Text>
        {failedCount > 0 ? (
          <Text style={styles.error}>
            {failedCount} {failedCount === 1 ? "entry" : "entries"} the server refused. They are
            still saved here.
          </Text>
        ) : null}
        {lastSyncAt ? (
          <Text style={styles.meta}>
            Last synced {new Date(lastSyncAt).toLocaleTimeString()}
          </Text>
        ) : (
          <Text style={styles.meta}>Not synced yet this session</Text>
        )}
        {lastSyncError ? <Text style={styles.error}>{lastSyncError}</Text> : null}

        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={() => void sync({ forceRoster: true, forceEvents: true, userInitiated: true })}
          disabled={syncing}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonTextDark}>{syncing ? "Syncing…" : "Sync now"}</Text>
        </TouchableOpacity>

        {failedCount > 0 ? (
          <TouchableOpacity
            style={[styles.button, styles.secondaryButton]}
            onPress={onRetryFailed}
            disabled={retrying || syncing}
            activeOpacity={0.85}
          >
            <Text style={styles.buttonTextDark}>
              {retrying ? "Retrying…" : `Retry ${failedCount} failed`}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {__DEV__ ? (
        <View style={styles.card}>
          <Text style={styles.label}>Server</Text>
          <Text style={styles.mono}>{SERVER_URL}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.button, styles.logoutButton]}
        onPress={confirmLogout}
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
    gap: 4,
  },
  name: { color: BRAND.bone, fontSize: 18, fontWeight: "800" },
  meta: { color: BRAND.smoke, fontSize: 13 },
  mono: { color: BRAND.smoke, fontSize: 11, fontFamily: "SpaceMono" },
  warn: { color: BRAND.amber, fontSize: 12, marginTop: 4 },
  role: {
    color: BRAND.signal,
    fontSize: 12,
    fontWeight: "700",
    marginTop: 2,
    textTransform: "uppercase",
  },
  syncHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
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
    elevation: 3,
  },
  secondaryButton: {
    backgroundColor: BRAND.surfaceRaised,
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  logoutButton: {
    backgroundColor: BRAND.crimsonDeep,
    borderColor: BRAND.crimson,
    borderWidth: 1,
  },
  buttonText: {
    color: BRAND.bone,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 0.5,
  },
  buttonTextDark: { color: BRAND.bone, fontWeight: "700", fontSize: 15 },
});
