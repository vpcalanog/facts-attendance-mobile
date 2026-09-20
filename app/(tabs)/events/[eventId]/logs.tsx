import CornerFlag from "@/components/corner-flag";
import { BRAND } from "@/constants/brand";
import { useSync } from "@/context/sync-context";
import { useEvent } from "@/hooks/use-event";
import {
  AttendanceWithStudent,
  countEntries,
  countEntriesToday,
  getAllEntriesForExport,
  getEntriesWithStudents,
} from "@/lib/db";
import { userMessage } from "@/lib/errors";
import { normalize } from "@/lib/extract";
import { fmtRelative, fmtTimestamp } from "@/lib/format";
import { log } from "@/lib/logger";
import { File, Paths } from "expo-file-system";
import { useFocusEffect } from "expo-router";
import * as Sharing from "expo-sharing";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

/** RFC 4180 quoting. Student names can contain commas, and an unescaped
 *  one silently shifts every later column in the exported file. */
function csvCell(value: string | null | undefined): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function LogsScreen() {
  const { eventId, event } = useEvent();
  const { sync } = useSync();

  const [entries, setEntries] = useState<AttendanceWithStudent[]>([]);
  const [total, setTotal] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("");

  // Monotonic token: only the newest query is allowed to write state.
  // Every keystroke used to fire an un-sequenced query, so a slower
  // earlier one could land last and show results for a stale term.
  const queryToken = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (q: string, { silent = false }: { silent?: boolean } = {}) => {
      if (!eventId) return;
      const token = ++queryToken.current;
      if (!silent) setLoading(true);
      try {
        const normalized = q ? normalize(q) : undefined;
        const [rows, count, today] = await Promise.all([
          getEntriesWithStudents({ eventId, search: normalized, limit: PAGE_SIZE, offset: 0 }),
          countEntries({ eventId, search: normalized }),
          countEntriesToday(eventId),
        ]);
        if (!mounted.current || token !== queryToken.current) return;
        setEntries(rows);
        setTotal(count);
        setTodayCount(today);
      } catch (err) {
        log.error("couldn't load logs", { message: userMessage(err) });
        if (mounted.current && token === queryToken.current) {
          setNotice(`Couldn't load the log: ${userMessage(err)}`);
        }
      } finally {
        if (mounted.current && token === queryToken.current) setLoading(false);
      }
    },
    [eventId]
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || entries.length >= total) return;
    const token = queryToken.current;
    setLoadingMore(true);
    try {
      const rows = await getEntriesWithStudents({
        eventId,
        search: debouncedSearch ? normalize(debouncedSearch) : undefined,
        limit: PAGE_SIZE,
        offset: entries.length,
      });
      if (!mounted.current || token !== queryToken.current) return;
      setEntries((prev) => [...prev, ...rows]);
    } catch (err) {
      log.warn("couldn't load more logs", { message: userMessage(err) });
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [debouncedSearch, entries.length, eventId, loadingMore, total]);

  useFocusEffect(
    useCallback(() => {
      void load(debouncedSearch, { silent: true });
    }, [load, debouncedSearch])
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await sync({ userInitiated: true });
      await load(debouncedSearch, { silent: true });
    } finally {
      setRefreshing(false);
    }
  }

  async function exportCsv() {
    if (!eventId) return;
    setNotice("");
    try {
      // Exports the whole event, not just the page currently rendered —
      // the old version serialised `entries`, so anything not yet scrolled
      // into view was silently missing from the file.
      const rows = await getAllEntriesForExport(eventId);
      if (!rows.length) {
        setNotice("There's nothing to export yet.");
        return;
      }

      const lines = ["Student Number,Name,Course,Year Level,Timestamp,Logged By,Synced"];
      for (const e of rows) {
        lines.push(
          [
            csvCell(e.studentNumber),
            csvCell(e.studentName),
            csvCell(e.studentCourse),
            csvCell(e.studentYearLevel),
            csvCell(e.timestamp),
            csvCell(e.loggedBy),
            e.synced ? "yes" : "no",
          ].join(",")
        );
      }

      const slug = (event?.name || "event").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      // expo-file-system's legacy string-URI API (cacheDirectory,
      // writeAsStringAsync, EncodingType) is gone in SDK 54 — this screen
      // did not compile against it, so CSV export was dead on arrival.
      const file = new File(Paths.cache, `${slug}-${new Date().toISOString().slice(0, 10)}.csv`);
      if (file.exists) file.delete();
      file.create();
      file.write(lines.join("\n"));

      if (!(await Sharing.isAvailableAsync())) {
        setNotice("Sharing isn't available on this device.");
        return;
      }
      await Sharing.shareAsync(file.uri, { mimeType: "text/csv", UTI: "public.comma-separated-values-text" });
    } catch (err) {
      log.error("csv export failed", { message: userMessage(err) });
      setNotice(`Couldn't export: ${userMessage(err)}`);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <CornerFlag size={22} />
        <View style={styles.header}>
          <View>
            <Text style={styles.count}>{todayCount} logged today</Text>
            <Text style={styles.subtle}>{event?.name || "Event"}</Text>
          </View>
        </View>

        <TextInput
          style={styles.search}
          placeholder="Search number or name"
          placeholderTextColor={BRAND.smoke}
          autoCapitalize="characters"
          autoCorrect={false}
          value={search}
          onChangeText={setSearch}
        />

        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.actionButton} onPress={exportCsv} activeOpacity={0.85}>
            <Text style={styles.actionText}>Export CSV</Text>
          </TouchableOpacity>
        </View>

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      </View>

      <FlatList
        data={entries}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={BRAND.signal}
          />
        }
        contentContainerStyle={{ paddingBottom: 24 }}
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        // Keeps a long event's list cheap to scroll rather than holding
        // every row mounted.
        initialNumToRender={12}
        windowSize={7}
        removeClippedSubviews
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View
              style={[
                styles.statusBar,
                {
                  backgroundColor: item.dead
                    ? BRAND.danger
                    : item.synced
                      ? BRAND.green
                      : BRAND.amber,
                },
              ]}
            />
            <View style={styles.rowBody}>
              <Text style={styles.sn}>{item.studentNumber}</Text>
              {item.studentName ? (
                <>
                  <Text style={styles.name}>{item.studentName}</Text>
                  <Text style={styles.meta}>
                    {[item.studentCourse, item.studentYearLevel].filter(Boolean).join(" • ")}
                  </Text>
                </>
              ) : (
                <Text style={styles.notFound}>Not in roster</Text>
              )}
              <Text style={styles.time}>
                {fmtTimestamp(item.timestamp)} · {fmtRelative(item.timestamp)}
              </Text>
              {item.dead ? (
                <Text style={styles.failed}>
                  Upload failed: {item.lastError || "rejected by the server"}
                </Text>
              ) : null}
            </View>
          </View>
        )}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator style={styles.footer} color={BRAND.signal} />
          ) : entries.length && entries.length >= total ? (
            <Text style={styles.footerText}>All {total} entries shown</Text>
          ) : null
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={styles.footer} color={BRAND.signal} />
          ) : (
            <Text style={styles.empty}>
              {debouncedSearch ? "No entries match that search." : "No entries yet."}
            </Text>
          )
        }
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
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
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
    fontFamily: "SpaceMono",
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
    borderColor: BRAND.line,
  },
  actionText: { color: BRAND.bone, fontSize: 12, fontWeight: "700" },
  notice: { color: BRAND.amber, fontSize: 12, marginTop: 10 },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: BRAND.surface,
    borderRadius: 10,
    marginBottom: 8,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  statusBar: { width: 4 },
  rowBody: { flex: 1, padding: 12 },
  sn: {
    color: BRAND.smoke,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 1,
    fontFamily: "SpaceMono",
  },
  name: { color: BRAND.bone, fontSize: 15, fontWeight: "700", marginTop: 2 },
  meta: { color: BRAND.smoke, fontSize: 12, marginTop: 1 },
  notFound: {
    color: BRAND.amber,
    fontSize: 12,
    marginTop: 2,
    fontWeight: "600",
  },
  time: { color: BRAND.smoke, fontSize: 11, marginTop: 4 },
  failed: { color: BRAND.danger, fontSize: 11, marginTop: 4 },
  footer: { marginTop: 16 },
  footerText: { color: BRAND.smoke, fontSize: 11, textAlign: "center", marginTop: 12 },
  empty: { color: BRAND.smoke, textAlign: "center", marginTop: 40 },
});
