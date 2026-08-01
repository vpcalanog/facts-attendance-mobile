import { BRAND } from "@/constants/brand";
import React from "react";
import { StyleSheet, View } from "react-native";

// A single triangular "blade" clipped into the top-left corner of whatever
// card it sits inside. Pairs with the card's borderRadius + overflow:hidden.
// This is the one recurring visual signature of the redesign — used
// sparingly, one per surface, never stacked.
export default function CornerFlag({ size = 26 }: { size?: number }) {
  return (
    <View
      pointerEvents="none"
      style={[
        styles.flag,
        {
          borderTopWidth: size,
          borderRightWidth: size
        }
      ]}
    />
  );
}

const styles = StyleSheet.create({
  flag: {
    position: "absolute",
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    borderTopColor: BRAND.signal,
    borderRightColor: "transparent",
    zIndex: 2
  }
});
