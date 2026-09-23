import CornerFlag from "@/components/corner-flag";
import StudentPreviewCard from "@/components/student-preview-card";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import { useEvent } from "@/hooks/use-event";
import { useOfficerCohort } from "@/hooks/use-officer-cohort";
import { checkOfficerCohortConflict, logAttendance } from "@/lib/attendance";
import { checkEventEligibility, findStudent, RosterRow } from "@/lib/db";
import { isCancelled, userMessage } from "@/lib/errors";
import { isValidId } from "@/lib/extract";
import { log } from "@/lib/logger";
import { recognizeStudentNumber } from "@/lib/ocr";
import { CameraCapturedPicture, CameraView, useCameraPermissions } from "expo-camera";
import { useFocusEffect } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function ScanScreen() {
  const { eventId, event } = useEvent();
  const { user } = useAuth();
  const { sync, refreshCounts } = useSync();
  const { cohort, status: cohortStatus } = useOfficerCohort();
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraActive, setCameraActive] = useState(true);
  const [cameraReady, setCameraReady] = useState(false);
  const [captured, setCaptured] = useState<CameraCapturedPicture | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [resultValue, setResultValue] = useState("");
  const [resultRepaired, setResultRepaired] = useState(false);
  const [resultVisible, setResultVisible] = useState(false);
  const [lookup, setLookup] = useState<{ studentNumber: string; row: RosterRow | null } | null>(
    null
  );
  const student = lookup?.studentNumber === resultValue ? lookup.row : null;
  const [dupWarning, setDupWarning] = useState<{ studentNumber: string; mins: number } | null>(
    null
  );
  const [confirmForce, setConfirmForce] = useState(false);
  const [logging, setLogging] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "warn"; text: string } | null>(null);
  const [viewfinderHeight, setViewfinderHeight] = useState(0);

  const cameraRef = useRef<CameraView>(null);
  // Lazy state rather than useRef(...).current, which reads a ref during
  // render and opts the screen out of the React Compiler.
  const [scanAnim] = useState(() => new Animated.Value(0));
  // Guards against a second tap landing before React has re-rendered with
  // the disabled state — the window in which two captures, two OCR
  // uploads or two attendance rows used to slip through.
  const capturing = useRef(false);
  const submitting = useRef(false);
  const ocrAbort = useRef<AbortController | null>(null);

  // Eligibility is derived, not stored. As stored state it went stale in
  // two ways: it was computed inside the OCR handler from whatever
  // `event` happened to be in that closure (null if the event hadn't
  // loaded yet, silently skipping the check), and it never recomputed
  // when a sync changed the event's course scoping.
  const eligibilityWarning = event && student ? checkEventEligibility(event, student) : null;

  // The conflict-of-interest rule. Shown as soon as the number resolves
  // to a student, so the officer sees the refusal on the result card
  // rather than discovering it after tapping Log.
  const cohortBlock = checkOfficerCohortConflict(cohort, student);

  useEffect(() => {
    if (ocrLoading) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(scanAnim, { toValue: 1, duration: 1200, useNativeDriver: true }),
          Animated.timing(scanAnim, { toValue: 0, duration: 1200, useNativeDriver: true }),
        ])
      ).start();
    } else {
      scanAnim.stopAnimation();
      scanAnim.setValue(0);
    }
  }, [ocrLoading, scanAnim]);

  // Look the student up whenever the detected number changes, cancelling
  // any lookup still in flight so an older result can't overwrite a newer.
  // The result is keyed by number, so a stale one simply doesn't match.
  useEffect(() => {
    if (!isValidId(resultValue)) return;
    let cancelled = false;
    void (async () => {
      const found = await findStudent(resultValue);
      if (!cancelled) setLookup({ studentNumber: resultValue, row: found });
    })();
    return () => {
      cancelled = true;
    };
  }, [resultValue]);

  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      return () => {
        setCameraActive(false);
        setCameraReady(false);
        // Leaving the screen mid-upload: stop paying for a multi-megabyte
        // image whose result nobody will see.
        ocrAbort.current?.abort();
      };
    }, [])
  );

  useEffect(() => () => ocrAbort.current?.abort(), []);

  async function captureAndScan() {
    if (capturing.current || !cameraRef.current || !cameraReady) return;
    capturing.current = true;

    setDupWarning(null);
    setConfirmForce(false);
    setToast(null);
    setResultVisible(false);

    const controller = new AbortController();
    ocrAbort.current = controller;

    try {
      // takePictureAsync used to sit outside the try block, so a camera
      // that wasn't ready rejected into an unhandled promise and the
      // screen simply did nothing.
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      if (!photo?.base64) {
        setToast({ type: "warn", text: "Couldn't capture the photo. Try again." });
        return;
      }
      setCaptured(photo);
      setOcrLoading(true);

      // Tries the barcode on the card, then the server, then an
      // on-device engine if one is registered — so a dead tunnel or no
      // signal no longer stops scanning outright.
      const result = await recognizeStudentNumber(
        { base64: photo.base64 },
        { signal: controller.signal }
      );

      if (controller.signal.aborted) return;
      setResultValue(result.studentNumber);
      setResultRepaired(result.repaired);
      setResultVisible(true);
      if (result.failure) {
        setToast({ type: "warn", text: result.failure });
      }
    } catch (err) {
      if (isCancelled(err)) return;
      log.warn("recognition failed", { message: userMessage(err) });
      setResultValue("");
      setResultRepaired(false);
      setResultVisible(true);
      setToast({
        type: "warn",
        text: `${userMessage(err)} You can still use the Manual tab.`,
      });
    } finally {
      capturing.current = false;
      if (ocrAbort.current === controller) ocrAbort.current = null;
      setOcrLoading(false);
    }
  }

  function retake() {
    ocrAbort.current?.abort();
    setCaptured(null);
    setResultVisible(false);
    setResultValue("");
    setResultRepaired(false);
    setDupWarning(null);
    setConfirmForce(false);
  }

  async function handleConfirm() {
    if (submitting.current) return;
    if (!eventId) return;
    const sn = resultValue;
    if (!isValidId(sn)) return;

    submitting.current = true;
    setLogging(true);
    try {
      const result = await logAttendance({
        studentNumber: sn,
        eventId,
        officer: user,
        officerCohort: cohort,
        force: confirmForce,
      });

      if (result.status === "blocked") {
        // Not overridable — withdraw any "Log anyway" affordance.
        setConfirmForce(false);
        setDupWarning(null);
        setToast({ type: "warn", text: result.message });
        return;
      }
      if (result.status === "needs-confirmation") {
        setDupWarning({ studentNumber: sn, mins: result.minutesAgo });
        setConfirmForce(true);
        return;
      }

      setToast({ type: "success", text: `${sn} logged at ${new Date().toLocaleTimeString()}` });
      retake();
      // Update the badge straight away: the entry is queued whether or not
      // the push that follows succeeds.
      void refreshCounts();
      void sync();
    } catch (err) {
      setToast({ type: "warn", text: `Couldn't save that scan: ${userMessage(err)}` });
      log.error("failed to save scan", { message: userMessage(err) });
    } finally {
      submitting.current = false;
      setLogging(false);
    }
  }

  const translateY = scanAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, viewfinderHeight > 0 ? viewfinderHeight : 400],
  });

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={BRAND.signal} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permText}>Camera access is needed to scan student IDs.</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission} activeOpacity={0.85}>
          <Text style={styles.buttonText}>Grant camera access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const canLog = isValidId(resultValue) && !logging && !cohortBlock;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View
        style={styles.viewfinder}
        onLayout={(layoutEvent) => {
          setViewfinderHeight(layoutEvent.nativeEvent.layout.height);
        }}
      >
        {captured ? (
          <Image source={{ uri: captured.uri }} style={styles.preview} resizeMode="contain" />
        ) : cameraActive ? (
          <CameraView
            ref={cameraRef}
            style={styles.preview}
            facing="back"
            onCameraReady={() => setCameraReady(true)}
          />
        ) : null}

        <View style={[styles.bracket, styles.bracketTL]} pointerEvents="none" />
        <View style={[styles.bracket, styles.bracketTR]} pointerEvents="none" />
        <View style={[styles.bracket, styles.bracketBL]} pointerEvents="none" />
        <View style={[styles.bracket, styles.bracketBR]} pointerEvents="none" />

        {ocrLoading && (
          <View style={styles.loadingOverlay}>
            <Animated.View style={[styles.scanBar, { transform: [{ translateY }] }]} />
          </View>
        )}
      </View>

      {!captured && (
        <TouchableOpacity
          style={[styles.button, !cameraReady && styles.buttonDisabled]}
          onPress={captureAndScan}
          disabled={!cameraReady}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>{cameraReady ? "Scan ID" : "Starting camera…"}</Text>
        </TouchableOpacity>
      )}

      {ocrLoading && (
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={retake}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonTextDark}>Cancel</Text>
        </TouchableOpacity>
      )}

      {toast && (
        <View
          style={[styles.notice, toast.type === "success" ? styles.noticeOk : styles.noticeWarn]}
        >
          <Text style={styles.noticeText}>{toast.text}</Text>
        </View>
      )}

      {resultVisible && (
        <View style={styles.resultCard}>
          <CornerFlag size={22} />
          <Text style={styles.resultLabel}>
            {resultValue
              ? "Detected student number — check it's correct"
              : "Couldn't auto-detect a number"}
          </Text>
          <Text style={styles.resultValue}>{resultValue || "—"}</Text>

          {resultRepaired && (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text style={styles.noticeText}>
                Some characters were unclear and had to be corrected (O/0, I/1, B/8). Check
                this against the card before logging it.
              </Text>
            </View>
          )}

          <StudentPreviewCard student={student} studentNumber={resultValue} />

          {cohortBlock && (
            <View style={[styles.notice, styles.noticeBlocked]}>
              <Text style={styles.noticeText}>{cohortBlock}</Text>
            </View>
          )}

          {cohortStatus === "pending" && (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text style={styles.noticeText}>
                Your course and year level haven&apos;t loaded yet, so the same-cohort check
                is inactive on this device.
              </Text>
            </View>
          )}

          {eligibilityWarning && (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text style={styles.noticeText}>{eligibilityWarning}</Text>
            </View>
          )}

          {dupWarning && (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text style={styles.noticeText}>
                {dupWarning.studentNumber} was already logged {dupWarning.mins} min ago at this
                event. Tap &quot;Log anyway&quot; to confirm.
              </Text>
            </View>
          )}

          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={retake}
              activeOpacity={0.85}
            >
              <Text style={styles.buttonTextDark}>Retake</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, !canLog && styles.buttonDisabled]}
              disabled={!canLog}
              onPress={handleConfirm}
              activeOpacity={0.85}
            >
              <Text style={styles.buttonText}>
                {logging ? "Saving…" : confirmForce ? "Log anyway" : "Log attendance"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, backgroundColor: BRAND.void, flexGrow: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 14,
    backgroundColor: BRAND.void,
  },
  permText: { textAlign: "center", fontSize: 14, color: BRAND.smoke },
  viewfinder: {
    aspectRatio: 3 / 4,
    borderRadius: 14,
    overflow: "hidden",
    flex: 1,
    alignSelf: "center",
    backgroundColor: "#000",
    borderWidth: 1,
    borderColor: BRAND.line,
    width: "75%",
  },
  preview: { width: "100%", height: "100%" },
  bracket: { position: "absolute", width: 30, height: 30 },
  bracketTL: {
    top: 12,
    left: 12,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderColor: BRAND.signal,
  },
  bracketTR: {
    top: 12,
    right: 12,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderColor: BRAND.signal,
  },
  bracketBL: {
    bottom: 12,
    left: 12,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderColor: BRAND.signal,
  },
  bracketBR: {
    bottom: 12,
    right: 12,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderColor: BRAND.signal,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(10,7,8,0.55)",
    overflow: "hidden",
  },
  scanBar: {
    width: "100%",
    height: 3,
    backgroundColor: BRAND.signal,
    shadowColor: BRAND.signal,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
    elevation: 5,
  },
  button: {
    backgroundColor: BRAND.signal,
    borderRadius: 10,
    alignItems: "center",
    alignSelf: "center",
    justifyContent: "center",
    shadowColor: BRAND.signal,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
    height: 50,
    width: 150,
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
  buttonContainer: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "center",
    marginTop: 12,
  },
  resultCard: {
    backgroundColor: BRAND.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: BRAND.line,
    overflow: "hidden",
  },
  resultLabel: { color: BRAND.smoke, fontSize: 13 },
  resultValue: {
    color: BRAND.bone,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 6,
    letterSpacing: 1,
    fontFamily: "SpaceMono",
  },
  notice: { padding: 10, borderRadius: 10, marginTop: 10 },
  noticeOk: { backgroundColor: BRAND.greenDim },
  noticeWarn: { backgroundColor: BRAND.amberDim },
  noticeBlocked: { backgroundColor: BRAND.crimsonDeep },
  noticeText: { color: BRAND.bone, fontSize: 13 },
});
