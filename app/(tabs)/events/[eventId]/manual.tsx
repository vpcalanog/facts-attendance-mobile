import CornerFlag from "@/components/corner-flag";
import StudentPreviewCard from "@/components/student-preview-card";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import {
    checkEventEligibility,
    EventRow,
    findRecentDuplicate,
    findStudent,
    getEvent,
    insertAttendance,
    RosterRow
} from "@/lib/db";
import { isValidId, normalize } from "@/lib/extract";
import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useState } from "react";
import {
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from "react-native";

const DUP_WINDOW_MS = 5 * 60 * 1000;

export default function ManualEntryScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { user } = useAuth();
  const { sync } = useSync();
  const [event, setEvent] = useState<EventRow | null>(null);
  const [value, setValue] = useState("");
  const [student, setStudent] = useState<RosterRow | null>(null);
  const [eligibilityWarning, setEligibilityWarning] = useState<string | null>(null);
  const [dupText, setDupText] = useState("");
  const [force, setForce] = useState(false);
  const [toast, setToast] = useState<{ text: string } | null>(null);

  useEffect(() => {
    if (!eventId) return;
    getEvent(eventId).then(setEvent);
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isValidId(value)) {
        setStudent(null);
        setEligibilityWarning(null);
        return;
      }
      const found = await findStudent(value);
      if (!cancelled) {
        setStudent(found);
        setEligibilityWarning(event ? checkEventEligibility(event, found) : null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [value, event]);

  function onChange(text: string) {
    setValue(normalize(text));
    setForce(false);
    setDupText("");
  }

  async function handleConfirm() {
    if (!eventId || !isValidId(value)) return;
    if (!force) {
      const dup = await findRecentDuplicate(value, DUP_WINDOW_MS, eventId);
      if (dup) {
        const mins = Math.max(
          1,
          Math.round((Date.now() - new Date(dup.timestamp).getTime()) / 60000)
        );
        setDupText(
          `${value} was logged ${mins} min ago at this event. Tap "Log anyway" to log again.`
        );
        setForce(true);
        return;
      }
    }
    await insertAttendance({ studentNumber: value, eventId, loggedBy: user?.username });
    setToast({ text: `${value} logged at ${new Date().toLocaleTimeString()}` });
    setValue("");
    setStudent(null);
    setEligibilityWarning(null);
    setForce(false);
    setDupText("");
    sync();
    setTimeout(() => setToast(null), 4000);
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <CornerFlag size={22} />
        <Text style={styles.label}>Manual attendance entry</Text>
        <TextInput
          style={[
            styles.input,
            value.length > 0 && !isValidId(value) && styles.inputInvalid
          ]}
          maxLength={11}
          value={value}
          placeholder="S20XXXXXXXX"
          placeholderTextColor={BRAND.smoke}
          autoCapitalize="characters"
          autoCorrect={false}
          onChangeText={onChange}
        />
        {value.length > 0 && (
          <Text
            style={[
              styles.validity,
              isValidId(value) ? styles.validityOk : styles.validityBad
            ]}
          >
            {isValidId(value)
              ? "Valid format"
              : "Expected format: S20 + 8 digits"}
          </Text>
        )}
      </View>

      {isValidId(value) && (
        <StudentPreviewCard student={student} studentNumber={value} />
      )}

      {eligibilityWarning ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{eligibilityWarning}</Text>
        </View>
      ) : null}

      {dupText ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{dupText}</Text>
        </View>
      ) : null}

      {toast ? (
        <View style={[styles.notice, styles.noticeOk]}>
          <Text style={styles.noticeText}>{toast.text}</Text>
        </View>
      ) : null}

      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={() => onChange("")}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonTextDark}>Clear</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, !isValidId(value) && styles.buttonDisabled]}
          disabled={!isValidId(value)}
          onPress={handleConfirm}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>
            {force ? "Log anyway" : "Log attendance"}
          </Text>
        </TouchableOpacity>
      </View>
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
    overflow: "hidden"
  },
  label: { color: BRAND.smoke, fontSize: 13, marginBottom: 8 },
  input: {
    backgroundColor: BRAND.void,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
    color: BRAND.bone,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 22,
    letterSpacing: 2,
    fontFamily: "SpaceMono"
  },
  inputInvalid: { borderColor: BRAND.danger },
  validity: { fontSize: 12, marginTop: 6 },
  validityOk: { color: BRAND.green },
  validityBad: { color: BRAND.danger },
  notice: { backgroundColor: BRAND.amberDim, padding: 10, borderRadius: 10 },
  noticeOk: { backgroundColor: BRAND.greenDim },
  noticeText: { color: BRAND.bone, fontSize: 13 },
  row: { flexDirection: "row", gap: 10 },
  button: {
    backgroundColor: BRAND.signal,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
    flex: 1,
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
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: BRAND.void,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 0.5
  },
  buttonTextDark: { color: BRAND.bone, fontWeight: "700", fontSize: 15 }
});
