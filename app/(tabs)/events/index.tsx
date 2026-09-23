import SyncStatusBadge from "@/components/sync-status-badge";
import { BRAND } from "@/constants/brand";
import { useSync } from "@/context/sync-context";
import { EventRow, getEvents } from "@/lib/db";
import { userMessage } from "@/lib/errors";
import { fmtTimeRange } from "@/lib/format";
import { log } from "@/lib/logger";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function EventsScreen() {
  const { sync, dbReady, dbError, lastSyncError, online } = useSync();
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!dbReady) return;
    try {
      const rows = await getEvents();
      if (!mounted.current) return;
      setEvents(rows);
      setLoadError("");
    } catch (err) {
      log.error("couldn't load events", { message: userMessage(err) });
      if (mounted.current) setLoadError(userMessage(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [dbReady]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      // userInitiated so a manual pull always tries the server, even if
      // the engine is currently backing off after repeated failures.
      await sync({ forceEvents: true, userInitiated: true });
      await load();
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  const problem = dbError || loadError;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.header}>
          <Text style={styles.title}>Events</Text>
        </View>
        <View style={styles.statusRow}>
          <SyncStatusBadge />
        </View>
      </View>

      {problem ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{problem}</Text>
        </View>
      ) : !online ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Offline — showing the events saved on this device. Scans still work.
          </Text>
        </View>
      ) : lastSyncError ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{lastSyncError} Pull down to retry.</Text>
        </View>
      ) : null}

      <FlatList
        data={events}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND.signal} />
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.85}
            onPress={() => router.push(`/events/${item.id}`)}
          >
            <Text style={styles.name}>{item.name}</Text>
            {item.description ? (
              <Text style={styles.description} numberOfLines={2}>
                {item.description}
              </Text>
            ) : null}
            {item.startsAt ? (
              <Text style={styles.meta}>{fmtTimeRange(item.startsAt, item.endsAt)}</Text>
            ) : null}
            {item.synced === 0 && <Text style={styles.pendingTag}>Not yet synced</Text>}
            {(item.courses.length > 0 || item.yearLevels.length > 0) && (
              <View style={styles.tags}>
                {item.courses.map((c) => (
                  <View key={`c-${c}`} style={styles.tag}>
                    <Text style={styles.tagText}>{c}</Text>
                  </View>
                ))}
                {item.yearLevels.map((y) => (
                  <View key={`y-${y}`} style={styles.tag}>
                    <Text style={styles.tagText}>{y}</Text>
                  </View>
                ))}
              </View>
            )}
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={BRAND.signal} />
          ) : (
            <Text style={styles.empty}>
              No events yet. Events are set up on the server and appear here after a sync.
            </Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.void, padding: 16 },
  toolbar: { marginBottom: 14 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusRow: { marginTop: 8 },
  title: { color: BRAND.bone, fontSize: 22, fontWeight: "800" },
  banner: {
    backgroundColor: BRAND.amberDim,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  bannerText: { color: BRAND.bone, fontSize: 12 },
  card: {
    backgroundColor: BRAND.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  name: { color: BRAND.bone, fontSize: 16, fontWeight: "700" },
  description: { color: BRAND.smoke, fontSize: 13, marginTop: 4 },
  meta: { color: BRAND.smoke, fontSize: 12, marginTop: 4 },
  pendingTag: {
    color: BRAND.amber,
    fontSize: 11,
    fontWeight: "600",
    marginTop: 4,
  },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  tag: {
    backgroundColor: BRAND.surfaceRaised,
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  tagText: { color: BRAND.smoke, fontSize: 11, fontWeight: "600" },
  empty: { color: BRAND.smoke, textAlign: "center", marginTop: 40 },
});
