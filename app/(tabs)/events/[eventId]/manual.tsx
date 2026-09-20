import CornerFlag from "@/components/corner-flag";
import StudentPreviewCard from "@/components/student-preview-card";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import { useEvent } from "@/hooks/use-event";
import { useOfficerCohort } from "@/hooks/use-officer-cohort";
import { checkOfficerCohortConflict, logAttendance } from "@/lib/attendance";
import { checkEventEligibility, findStudent, RosterRow } from "@/lib/db";
import { userMessage } from "@/lib/errors";
import { isValidId, normalize } from "@/lib/extract";
import { log } from "@/lib/logger";
import React, { useEffect, useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

const TOAST_MS = 4000;

export default function ManualEntryScreen() {
  const { eventId, event } = useEvent();
  const { user } = useAuth();
  const { sync, refreshCounts } = useSync();
  const { cohort, status: cohortStatus } = useOfficerCohort();
  const [value, setValue] = useState("");
  const [student, setStudent] = useState<RosterRow | null>(null);
  const [dupText, setDupText] = useState("");
  const [force, setForce] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ text: string } | null>(null);

  const submitting = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived rather than stored, so it can't disagree with the event once
  // a sync changes the event's course/year scoping.
  const eligibilityWarning = event && student ? checkEventEligibility(event, student) : null;

  // Evaluated as they type, so the refusal is visible before they reach
  // for the button rather than after tapping it.
  const cohortBlock = checkOfficerCohortConflict(cohort, student);

  useEffect(() => {
    let cancelled = false;
    if (!isValidId(value)) {
      setStudent(null);
      return;
    }
    void (async () => {
      const found = await findStudent(value);
      if (!cancelled) setStudent(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [value]);

  // The toast timer used to outlive the screen, firing setState on an
  // unmounted component after a quick navigation away.
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(text: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text });
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  function onChange(text: string) {
    setValue(normalize(text));
    setForce(false);
    setDupText("");
    setError("");
  }

  async function handleConfirm() {
    if (submitting.current) return;
    if (!eventId || !isValidId(value)) return;

    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await logAttendance({
        studentNumber: value,
        eventId,
        officer: user,
        officerCohort: cohort,
        force,
      });

      if (result.status === "blocked") {
        // Not overridable — clear any pending "Log anyway" affordance.
        setError(result.message);
        setForce(false);
        setDupText("");
        return;
      }
      if (result.status === "needs-confirmation") {
        setDupText(`${result.message} Tap "Log anyway" to log again.`);
        setForce(true);
        return;
      }

      showToast(`${value} logged at ${new Date().toLocaleTimeString()}`);
      setValue("");
      setStudent(null);
      setForce(false);
      setDupText("");
      // The badge should reflect the queued entry immediately, not only
      // once the push that follows happens to succeed.
      void refreshCounts();
      void sync();
    } catch (err) {
      setError(`Couldn't save that entry: ${userMessage(err)}`);
      log.error("failed to save manual entry", { message: userMessage(err) });
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  const canSubmit = isValidId(value) && !saving && !cohortBlock;

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <CornerFlag size={22} />
        <Text style={styles.label}>Manual attendance entry</Text>
        <TextInput
          style={[styles.input, value.length > 0 && !isValidId(value) && styles.inputInvalid]}
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
            style={[styles.validity, isValidId(value) ? styles.validityOk : styles.validityBad]}
          >
            {isValidId(value) ? "Valid format" : "Expected format: S20 + 8 digits"}
          </Text>
        )}
      </View>

      {isValidId(value) && <StudentPreviewCard student={student} studentNumber={value} />}

      {cohortBlock ? (
        <View style={[styles.notice, styles.noticeBad]}>
          <Text style={styles.noticeText}>{cohortBlock}</Text>
        </View>
      ) : null}

      {cohortStatus === "pending" ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            Your course and year level haven&apos;t loaded yet, so the same-cohort check is
            inactive on this device. Pull to refresh on the Logs tab once you&apos;re online.
          </Text>
        </View>
      ) : null}

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

      {error ? (
        <View style={[styles.notice, styles.noticeBad]}>
          <Text style={styles.noticeText}>{error}</Text>
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
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          disabled={!canSubmit}
          onPress={handleConfirm}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>
            {saving ? "Saving…" : force ? "Log anyway" : "Log attendance"}
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
    overflow: "hidden",
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
    fontFamily: "SpaceMono",
  },
  inputInvalid: { borderColor: BRAND.danger },
  validity: { fontSize: 12, marginTop: 6 },
  validityOk: { color: BRAND.green },
  validityBad: { color: BRAND.danger },
  notice: { backgroundColor: BRAND.amberDim, padding: 10, borderRadius: 10 },
  noticeOk: { backgroundColor: BRAND.greenDim },
  noticeBad: { backgroundColor: BRAND.crimsonDeep },
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
    elevation: 3,
  },
  secondaryButton: {
    backgroundColor: BRAND.surfaceRaised,
    shadowOpacity: 0,
    elevation: 0,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: BRAND.bone,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 0.5,
  },
  buttonTextDark: { color: BRAND.bone, fontWeight: "700", fontSize: 15 },
});
