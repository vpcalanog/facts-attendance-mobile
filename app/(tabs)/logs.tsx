import CornerFlag from "@/components/corner-flag";
import SyncStatusBadge from "@/components/sync-status-badge";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import { AttendanceRow, findStudent, getAllEntries, RosterRow } from "@/lib/db";
import { normalize } from "@/lib/extract";
import { fmtRelative, fmtTimestamp, isToday } from "@/lib/format";
import * as FileSystem from "expo-file-system";
import { useFocusEffect } from "expo-router";
import * as Sharing from "expo-sharing";
import React, { useCallback, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";

export default function LogsScreen() {
  const { user, logout } = useAuth();
  const { sync, syncing } = useSync();
  const [entries, setEntries] = useState<AttendanceRow[]>([]);
  const [roster, setRoster] = useState<Record<string, RosterRow>>({});
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (q: string) => {
    const rows = await getAllEntries({ search: q ? normalize(q) : undefined });
    setEntries(rows);

    // Enrich with roster info so each row can show who was actually
    // scanned, not just their number — one lookup per unique student.
    // Normalize first: entries logged via OCR aren't guaranteed to be in
    // the same exact form as the roster's student numbers, even though
    // they refer to the same student.
    const uniqueNumbers = Array.from(
      new Set(rows.map((r) => normalize(r.studentNumber)))
    );
    const found = await Promise.all(
      uniqueNumbers.map(async (sn) => [sn, await findStudent(sn)] as const)
    );
    const map: Record<string, RosterRow> = {};
    for (const [sn, row] of found) {
      if (!row) continue;
      map[sn] = {
        studentNumber: row.studentNumber,
        name: row.name,
        course: row.course,
        yearLevel: row.yearLevel
      };
    }
    setRoster(map);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(search);
    }, [load, search])
  );

  async function onRefresh() {
    setRefreshing(true);
    await sync();
    await load(search);
    setRefreshing(false);
  }

  const todayCount = entries.filter((e) => isToday(e.timestamp)).length;

  async function exportCsv() {
    const rows = ["Student Number,Timestamp,Logged By,Synced"];
    entries
      .slice()
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      )
      .forEach((e) =>
        rows.push(
          `${e.studentNumber},${e.timestamp},${e.loggedBy || ""},${e.synced ? "yes" : "no"}`
        )
      );
    const csv = rows.join("\n");
    const fileUri = `${FileSystem.cacheDirectory}attendance-${new Date().toISOString().slice(0, 10)}.csv`;
    await FileSystem.writeAsStringAsync(fileUri, csv, {
      encoding: FileSystem.EncodingType.UTF8
    });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(fileUri, { mimeType: "text/csv" });
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <CornerFlag size={22} />
        <View style={styles.header}>
          <View>
            <Text style={styles.count}>{todayCount} logged today</Text>
            <Text style={styles.subtle}>
              Signed in as {user?.name || user?.username}
            </Text>
          </View>
          <SyncStatusBadge />
        </View>

        <TextInput
          style={styles.search}
          placeholder="Search student number"
          placeholderTextColor={BRAND.smoke}
          autoCapitalize="characters"
          value={search}
          onChangeText={(t) => {
            setSearch(t);
            load(t);
          }}
        />

        <View style={styles.actionsRow}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => sync({ forceRoster: true })}
            disabled={syncing}
            activeOpacity={0.85}
          >
            <Text style={styles.actionText}>
              {syncing ? "Syncing…" : "Sync now"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={exportCsv}
            activeOpacity={0.85}
          >
            <Text style={styles.actionText}>Export CSV</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionButton, styles.logoutButton]}
            onPress={logout}
            activeOpacity={0.85}
          >
            <Text style={styles.actionText}>Log out</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        extraData={roster}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={BRAND.signal}
          />
        }
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => {
          const info = roster[normalize(item.studentNumber)];
          return (
            <View style={styles.row}>
              <View
                style={[
                  styles.statusBar,
                  { backgroundColor: item.synced ? BRAND.green : BRAND.amber }
                ]}
              />
              <View style={styles.rowBody}>
                <Text style={styles.sn}>{item.studentNumber}</Text>
                {info ? (
                  <>
                    <Text style={styles.name}>{info.name}</Text>
                    <Text style={styles.meta}>
                      {[info.course, info.yearLevel]
                        .filter(Boolean)
                        .join(" • ")}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.notFound}>Not in roster</Text>
                )}
                <Text style={styles.time}>
                  {fmtTimestamp(item.timestamp)} · {fmtRelative(item.timestamp)}
                </Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No entries yet.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.void, padding: 16 },
  toolbar: {
    backgroundColor: BRAND.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BRAND.line,
    padding: 14,
    marginBottom: 14,
    overflow: "hidden"
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12
  },
  count: { color: BRAND.bone, fontSize: 18, fontWeight: "800" },
  subtle: { color: BRAND.smoke, fontSize: 12, marginTop: 2 },
  search: {
    backgroundColor: BRAND.void,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: BRAND.bone,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
    fontFamily: "SpaceMono"
  },
  actionsRow: { flexDirection: "row", gap: 8 },
  actionButton: {
    backgroundColor: BRAND.surfaceRaised,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    flex: 1,
    alignItems: "center",
    borderWidth: 1,
    borderColor: BRAND.line
  },
  logoutButton: {
    backgroundColor: BRAND.crimsonDeep,
    borderColor: BRAND.crimson
  },
  actionText: { color: BRAND.bone, fontSize: 12, fontWeight: "700" },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: BRAND.surface,
    borderRadius: 10,
    marginBottom: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: BRAND.line
  },
  statusBar: { width: 4 },
  rowBody: { flex: 1, padding: 12 },
  sn: {
    color: BRAND.smoke,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    fontFamily: "SpaceMono"
  },
  name: { color: BRAND.bone, fontSize: 15, fontWeight: "700", marginTop: 2 },
  meta: { color: BRAND.smoke, fontSize: 12, marginTop: 1 },
  notFound: {
    color: BRAND.amber,
    fontSize: 12,
    marginTop: 2,
    fontWeight: "600"
  },
  time: { color: BRAND.smoke, fontSize: 11, marginTop: 4 },
  empty: { color: BRAND.smoke, textAlign: "center", marginTop: 40 }
});
