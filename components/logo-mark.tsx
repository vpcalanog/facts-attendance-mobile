import { BRAND, LOGO_SOURCE } from "@/constants/brand";
import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";

interface LogoMarkProps {
  size?: number;
  withWordmark?: boolean;
  align?: "row" | "column";
}

export default function LogoMark({
  size = 36,
  withWordmark = false,
  align = "row"
}: LogoMarkProps) {
  return (
    <View
      style={[
        styles.wrap,
        { flexDirection: align === "row" ? "row" : "column" }
      ]}
    >
      <Image
        source={LOGO_SOURCE}
        style={{ width: size, height: size }}
        resizeMode="contain"
      />
      {withWordmark && (
        <View
          style={{
            marginLeft: align === "row" ? 10 : 0,
            marginTop: align === "row" ? 0 : 6,
            alignItems: align === "row" ? "flex-start" : "center"
          }}
        >
          <Text style={[styles.word, { fontSize: size * 0.44 }]}>FACTS</Text>
          <Text
            style={[styles.eyebrow, { fontSize: Math.max(9, size * 0.18) }]}
          >
            ATTENDANCE
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  word: { color: BRAND.bone, fontWeight: "900", letterSpacing: 2 },
  eyebrow: {
    color: BRAND.smoke,
    fontWeight: "700",
    letterSpacing: 3,
    marginTop: 1
  }
});
