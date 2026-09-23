import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import { createEventLocal, getRosterFacets } from "@/lib/db";
import { userMessage } from "@/lib/errors";
import { log } from "@/lib/logger";
import { useRouter } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

export default function CreateEventScreen() {
  const { user } = useAuth();
  const { sync, online } = useSync();
  const router = useRouter();

  // ASSUMPTION: role === "admin" gates event creation. Adjust this if
  // your backend uses a different role string.
  const isAdmin = user?.role === "admin";

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [courses, setCourses] = useState<string[]>([]);
  const [yearLevels, setYearLevels] = useState<string[]>([]);
  const [facets, setFacets] = useState<{ courses: string[]; yearLevels: string[] }>({
    courses: [],
    yearLevels: [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Previously an unhandled rejection: a failure here left the chips
    // silently empty with no explanation.
    getRosterFacets()
      .then((f) => {
        if (!cancelled) setFacets(f);
      })
      .catch((err) => {
        log.warn("couldn't read roster facets", { message: userMessage(err) });
        if (!cancelled) setError("Couldn't read the roster, so course filters are unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isAdmin) return;
    // router.back() throws when this screen was opened directly (deep
    // link, reload on this route) and there is nothing to go back to.
    if (router.canGoBack()) router.back();
    else router.replace("/events");
  }, [isAdmin, router]);

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function handleCreate() {
    // `saving` only takes effect on the next render, so a fast double tap
    // would otherwise create the event twice.
    if (submitting.current) return;
    if (!name.trim()) {
      setError("Give the event a name.");
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const event = await createEventLocal({
        name: name.trim(),
        description: description.trim() || null,
        courses,
        yearLevels,
        createdBy: user?.username || null,
      });
      // Push right away rather than waiting for the next timer tick, so
      // the event is usable across devices as soon as possible. Navigating
      // to the temporary id is safe: once the server assigns the real one,
      // resolveEventId() follows the rename and any attendance logged
      // against the temp id is re-pointed with it.
      void sync({ forceEvents: true, userInitiated: true });
      router.replace(`/events/${event.id}`);
    } catch (err) {
      log.error("couldn't create event", { message: userMessage(err) });
      setError(`Couldn't create the event: ${userMessage(err)}`);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.label}>Event name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="e.g. Freshman Orientation"
          placeholderTextColor={BRAND.smoke}
        />

        <Text style={[styles.label, styles.section]}>Description (optional)</Text>
        <TextInput
          style={[styles.input, styles.multiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Where it's held, who to ask, anything useful"
          placeholderTextColor={BRAND.smoke}
          multiline
          numberOfLines={3}
        />

        <Text style={[styles.label, styles.section]}>
          Courses (leave blank for all courses)
        </Text>
        <View style={styles.chips}>
          {facets.courses.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.chip, courses.includes(c) && styles.chipActive]}
              onPress={() => toggle(courses, setCourses, c)}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, courses.includes(c) && styles.chipTextActive]}>
                {c}
              </Text>
            </TouchableOpacity>
          ))}
          {facets.courses.length === 0 && (
            <Text style={styles.subtle}>No courses found in roster yet.</Text>
          )}
        </View>

        <Text style={[styles.label, styles.section]}>
          Year levels (leave blank for all year levels)
        </Text>
        <View style={styles.chips}>
          {facets.yearLevels.map((y) => (
            <TouchableOpacity
              key={y}
              style={[styles.chip, yearLevels.includes(y) && styles.chipActive]}
              onPress={() => toggle(yearLevels, setYearLevels, y)}
              activeOpacity={0.85}
            >
              <Text style={[styles.chipText, yearLevels.includes(y) && styles.chipTextActive]}>
                {y}
              </Text>
            </TouchableOpacity>
          ))}
          {facets.yearLevels.length === 0 && (
            <Text style={styles.subtle}>No year levels found in roster yet.</Text>
          )}
        </View>
      </View>

      {!online ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            You&apos;re offline. The event is saved on this device and uploads automatically
            once you&apos;re back on a network.
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{error}</Text>
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.button, saving && styles.buttonDisabled]}
        onPress={handleCreate}
        disabled={saving}
        activeOpacity={0.85}
      >
        <Text style={styles.buttonText}>{saving ? "Creating…" : "Create event"}</Text>
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
  },
  label: { color: BRAND.smoke, fontSize: 13, marginBottom: 8 },
  section: { marginTop: 18 },
  input: {
    backgroundColor: BRAND.void,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
    color: BRAND.bone,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
  },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: BRAND.line,
    backgroundColor: BRAND.surfaceRaised,
  },
  chipActive: { backgroundColor: BRAND.signal, borderColor: BRAND.signal },
  chipText: { color: BRAND.smoke, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: BRAND.void },
  subtle: { color: BRAND.smoke, fontSize: 12 },
  notice: { backgroundColor: BRAND.amberDim, padding: 10, borderRadius: 10 },
  noticeText: { color: BRAND.bone, fontSize: 13 },
  button: {
    backgroundColor: BRAND.signal,
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: "center",
    shadowColor: BRAND.signal,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    color: BRAND.void,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 0.5,
  },
});
