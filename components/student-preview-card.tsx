import { BRAND } from "@/constants/brand";
import type { RosterRow } from "@/lib/db";
import React from "react";
import { StyleSheet, Text, View } from "react-native";

export default function StudentPreviewCard({
  student,
  studentNumber,
  notFoundText = "Not found in the student roster."
}: {
  student: RosterRow | null;
  /** The number that was scanned or typed — shown regardless of whether a
   *  roster match was found, so the person can see exactly what's being
   *  checked. */
  studentNumber?: string;
  notFoundText?: string;
}) {
  const number = studentNumber ?? student?.studentNumber ?? "";

  if (!student) {
    return (
      <View style={[styles.card, styles.warn]}>
        <View style={[styles.statusBar, { backgroundColor: BRAND.amber }]} />
        <View style={styles.body}>
          {!!number && <Text style={styles.number}>{number}</Text>}
          <Text style={styles.warnText}>{notFoundText}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.card, styles.ok]}>
      <View style={[styles.statusBar, { backgroundColor: BRAND.green }]} />
      <View style={styles.body}>
        {!!number && <Text style={styles.number}>{number}</Text>}
        <Text style={styles.name}>{student.name}</Text>
        <Text style={styles.meta}>
          {[student.course, student.yearLevel].filter(Boolean).join(" • ")}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 10,
    overflow: "hidden"
  },
  statusBar: { width: 4 },
  body: { flex: 1, padding: 12 },
  ok: { backgroundColor: BRAND.surfaceRaised, borderColor: BRAND.line },
  warn: { backgroundColor: BRAND.surfaceRaised, borderColor: BRAND.line },
  number: {
    fontFamily: "SpaceMono",
    fontSize: 13,
    color: BRAND.smoke,
    letterSpacing: 1,
    marginBottom: 4
  },
  name: { fontWeight: "700", fontSize: 15, color: BRAND.bone },
  meta: { fontSize: 13, color: BRAND.smoke, marginTop: 2 },
  warnText: { fontSize: 13, color: BRAND.bone }
});
