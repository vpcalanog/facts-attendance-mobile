import CornerFlag from "@/components/corner-flag";
import StudentPreviewCard from "@/components/student-preview-card";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { useSync } from "@/context/sync-context";
import { authFetch } from "@/lib/api";
import {
  checkEventEligibility,
  EventRow,
  findRecentDuplicate,
  findStudent,
  getEvent,
  insertAttendance,
  RosterRow,
} from "@/lib/db";
import { extractCandidate, isValidId } from "@/lib/extract";
import {
  CameraCapturedPicture,
  CameraView,
  useCameraPermissions,
} from "expo-camera";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
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

const DUP_WINDOW_MS = 5 * 60 * 1000;

interface OcrWord {
  WordText?: string;
}
interface OcrLine {
  Words?: OcrWord[];
}

export default function ScanScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { user } = useAuth();
  const { sync } = useSync();
  const [event, setEvent] = useState<EventRow | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraActive, setCameraActive] = useState(true);
  const [captured, setCaptured] = useState<CameraCapturedPicture | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [resultValue, setResultValue] = useState("");
  const [resultVisible, setResultVisible] = useState(false);
  const [student, setStudent] = useState<RosterRow | null>(null);
  const [eligibilityWarning, setEligibilityWarning] = useState<string | null>(null);
  const [dupWarning, setDupWarning] = useState<{
    studentNumber: string;
    mins: number;
  } | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [toast, setToast] = useState<{
    type: "success" | "warn";
    text: string;
  } | null>(null);
  const [viewfinderHeight, setViewfinderHeight] = useState(0);
  const cameraRef = useRef<CameraView>(null);
  const scanAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!eventId) return;
    getEvent(eventId).then(setEvent);
  }, [eventId]);

  useEffect(() => {
    if (ocrLoading) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(scanAnim, {
            toValue: 1,
            duration: 1200,
            useNativeDriver: true,
          }),
          Animated.timing(scanAnim, {
            toValue: 0,
            duration: 1200,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      scanAnim.setValue(0);
    }
  }, [ocrLoading, scanAnim]);

  useFocusEffect(
    useCallback(() => {
      setCameraActive(true);
      return () => setCameraActive(false);
    }, []),
  );

  async function lookupStudent(sn: string) {
    if (!isValidId(sn)) {
      setStudent(null);
      setEligibilityWarning(null);
      return;
    }
    const found = await findStudent(sn);
    setStudent(found);
    setEligibilityWarning(event ? checkEventEligibility(event, found) : null);
  }

  async function captureAndScan() {
    if (!cameraRef.current) return;
    setDupWarning(null);
    setConfirmForce(false);
    setToast(null);
    setResultVisible(false);

    const photo = await cameraRef.current.takePictureAsync({
      base64: true,
      quality: 0.5,
    });
    if (!photo) return;
    setCaptured(photo);
    setOcrLoading(true);

    try {
      const data = await authFetch("/api/ocr", {
        method: "POST",
        body: JSON.stringify({
          imageBase64: `data:image/jpeg;base64,${photo.base64}`,
        }),
      });

      const lines: OcrLine[] = data.lines || [];
      let candidate = "";
      outerWordLoop: for (const line of lines) {
        for (const w of line.Words || []) {
          const c = extractCandidate(w.WordText || "");
          if (c) {
            candidate = c;
            break outerWordLoop;
          }
        }
      }
      if (!candidate) {
        for (const line of lines) {
          const c = extractCandidate(
            (line.Words || []).map((w) => w.WordText).join(" "),
          );
          if (c) {
            candidate = c;
            break;
          }
        }
      }
      if (!candidate) candidate = extractCandidate(data.text || "");

      setResultValue(candidate);
      await lookupStudent(candidate);
    } catch (err: any) {
      setToast({
        type: "warn",
        text:
          err?.message || "OCR request failed — try the Manual tab instead.",
      });
      setResultValue("");
    } finally {
      setOcrLoading(false);
      setResultVisible(true);
    }
  }

  function retake() {
    setCaptured(null);
    setResultVisible(false);
    setResultValue("");
    setStudent(null);
    setEligibilityWarning(null);
    setDupWarning(null);
    setConfirmForce(false);
  }

  async function handleConfirm() {
    if (!eventId) return;
    const sn = resultValue;
    if (!isValidId(sn)) return;
    if (!confirmForce) {
      const dup = await findRecentDuplicate(sn, DUP_WINDOW_MS, eventId);
      if (dup) {
        const mins = Math.max(
          1,
          Math.round((Date.now() - new Date(dup.timestamp).getTime()) / 60000),
        );
        setDupWarning({ studentNumber: sn, mins });
        setConfirmForce(true);
        return;
      }
    }
    await insertAttendance({ studentNumber: sn, eventId, loggedBy: user?.username });
    setToast({
      type: "success",
      text: `${sn} logged at ${new Date().toLocaleTimeString()}`,
    });
    retake();
    sync();
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
        <Text style={styles.permText}>
          Camera access is needed to scan student IDs.
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={requestPermission}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>Grant camera access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View
        style={styles.viewfinder}
        onLayout={(layoutEvent) => {
          setViewfinderHeight(layoutEvent.nativeEvent.layout.height);
        }}
      >
        {captured ? (
          <Image
            source={{ uri: captured.uri }}
            style={styles.preview}
            resizeMode="contain"
          />
        ) : cameraActive ? (
          <CameraView ref={cameraRef} style={styles.preview} facing="back" />
        ) : null}

        <View style={[styles.bracket, styles.bracketTL]} pointerEvents="none" />
        <View style={[styles.bracket, styles.bracketTR]} pointerEvents="none" />
        <View style={[styles.bracket, styles.bracketBL]} pointerEvents="none" />
        <View style={[styles.bracket, styles.bracketBR]} pointerEvents="none" />

        {ocrLoading && (
          <View style={styles.loadingOverlay}>
            <Animated.View
              style={[styles.scanBar, { transform: [{ translateY }] }]}
            />
          </View>
        )}
      </View>

      {!captured && (
        <TouchableOpacity
          style={styles.button}
          onPress={captureAndScan}
          activeOpacity={0.85}
        >
          <Text style={styles.buttonText}>Scan ID</Text>
        </TouchableOpacity>
      )}

      {toast && (
        <View
          style={[
            styles.notice,
            toast.type === "success" ? styles.noticeOk : styles.noticeWarn,
          ]}
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

          <StudentPreviewCard student={student} studentNumber={resultValue} />

          {eligibilityWarning && (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text style={styles.noticeText}>{eligibilityWarning}</Text>
            </View>
          )}

          {dupWarning && (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text style={styles.noticeText}>
                {dupWarning.studentNumber} was already logged {dupWarning.mins}{" "}
                min ago at this event. Tap "Log anyway" to confirm.
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
              style={[
                styles.button,
                !isValidId(resultValue) && styles.buttonDisabled,
              ]}
              disabled={!isValidId(resultValue)}
              onPress={handleConfirm}
              activeOpacity={0.85}
            >
              <Text style={styles.buttonText}>
                {confirmForce ? "Log anyway" : "Log attendance"}
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
    backgroundColor: "#000",
    borderWidth: 1,
    borderColor: BRAND.line,
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
    ...StyleSheet.absoluteFillObject,
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
    paddingVertical: 20,
    alignItems: "center",
    alignSelf: "center",
    justifyContent: "center",
    shadowColor: BRAND.signal,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
    height: 75,
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
    color: BRAND.void,
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
  row: { flexDirection: "row", gap: 20, marginTop: 12 },
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
  noticeText: { color: BRAND.bone, fontSize: 13 },
});
