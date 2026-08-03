import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import { EventRow, getEvents } from "@/lib/db";
import { fmtTimestamp } from "@/lib/format";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function EventsScreen() {
  const { user } = useAuth();
  const { sync } = useSync();
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // ASSUMPTION: role === "admin" gates event creation. Adjust this if
  // your backend uses a different role string.
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    setEvents(await getEvents());
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await sync({ forceEvents: true });
    await load();
    setRefreshing(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.header}>
          <Text style={styles.title}>Events</Text>
          {isAdmin && (
            <TouchableOpacity
              style={styles.newButton}
              onPress={() => router.push("/events/create")}
              activeOpacity={0.85}
            >
              <Ionicons name="add" size={16} color={BRAND.void} />
              <Text style={styles.newButtonText}>New</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <FlatList
        data={events}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={BRAND.signal}
          />
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.85}
            onPress={() => router.push(`/events/${item.id}`)}
          >
            <Text style={styles.name}>{item.name}</Text>
            {item.startsAt ? (
              <Text style={styles.meta}>{fmtTimestamp(item.startsAt)}</Text>
            ) : null}
            {item.synced === 0 && (
              <Text style={styles.pendingTag}>Not yet synced</Text>
            )}
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
          <Text style={styles.empty}>
            {isAdmin
              ? "No events yet — tap New to create one."
              : "No events yet."}
          </Text>
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
  title: { color: BRAND.bone, fontSize: 22, fontWeight: "800" },
  newButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: BRAND.signal,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  newButtonText: { color: BRAND.void, fontWeight: "800", fontSize: 13 },
  card: {
    backgroundColor: BRAND.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  name: { color: BRAND.bone, fontSize: 16, fontWeight: "700" },
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
