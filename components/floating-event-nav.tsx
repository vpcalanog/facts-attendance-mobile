import { BRAND } from "@/constants/brand";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useSegments } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

const BUTTON_SIZE = 58;
const SATELLITE_SIZE = 52;
const SATELLITE_RADIUS = 92;
const HIT_RADIUS = 46;
const HOLD_MS = 220;

const ANCHOR_BOTTOM = 100;
const ANCHOR_RIGHT = 24;

type OptionKey = "index" | "manual" | "logs";

const OPTIONS: {
  key: OptionKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  angle: number;
}[] = [
  { key: "manual", label: "Manual", icon: "keypad", angle: -180 },
  { key: "index", label: "Scan", icon: "camera", angle: -135 },
  { key: "logs", label: "Logs", icon: "list", angle: -90 },
];

function offsetFor(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { dx: Math.cos(rad) * radius, dy: Math.sin(rad) * radius };
}

function Satellite({
  option,
  menuProgress,
  highlighted,
}: {
  option: (typeof OPTIONS)[number];
  menuProgress: SharedValue<number>;
  highlighted: boolean;
}) {
  const { dx, dy } = offsetFor(option.angle, SATELLITE_RADIUS);
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: dx * menuProgress.value },
      { translateY: dy * menuProgress.value },
      { scale: menuProgress.value },
    ],
    opacity: menuProgress.value,
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.satellite, style, highlighted && styles.satelliteActive]}
    >
      <Ionicons
        name={option.icon}
        size={20}
        color={highlighted ? BRAND.void : BRAND.bone}
      />
    </Animated.View>
  );
}

export default function FloatingEventNav({ eventId }: { eventId: string }) {
  const router = useRouter();
  const segments = useSegments();
  const last = segments[segments.length - 1];
  const activeKey: OptionKey =
    last === "manual" ? "manual" : last === "logs" ? "logs" : "index";

  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<OptionKey | null>(null);
  const menuProgress = useSharedValue(0);

  function navigateTo(key: OptionKey) {
    if (key === activeKey) return;

    const path =
      key === "index" ? `/events/${eventId}` : `/events/${eventId}/${key}`;

    // @ts-ignore
    router.replace(path);
  }

  function handleOpen() {
    setOpen(true);
    setHighlighted(null);
    menuProgress.value = withSpring(1, {
      damping: 20,
      stiffness: 90,
      mass: 1,
      overshootClamping: true,
    });
  }

  function handleClose(selected: OptionKey | null) {
    menuProgress.value = withSpring(0, {
      damping: 20,
      stiffness: 90,
      mass: 1,
      overshootClamping: true,
    });
    setOpen(false);
    setHighlighted(null);
    if (selected) navigateTo(selected);
  }

  function updateHighlight(dx: number, dy: number) {
    let closest: OptionKey | null = null;
    let closestDist = HIT_RADIUS;
    for (const opt of OPTIONS) {
      const target = offsetFor(opt.angle, SATELLITE_RADIUS);
      const dist = Math.hypot(dx - target.dx, dy - target.dy);
      if (dist < closestDist) {
        closestDist = dist;
        closest = opt.key;
      }
    }
    setHighlighted(closest);
  }

  const panGesture = Gesture.Pan()
    .activateAfterLongPress(HOLD_MS)
    .onStart(() => {
      runOnJS(handleOpen)();
    })
    .onUpdate((e) => {
      runOnJS(updateHighlight)(e.translationX, e.translationY);
    })
    .onEnd(() => {
      runOnJS(handleClose)(highlighted);
    })
    .onFinalize(() => {
      runOnJS(handleClose)(null);
    });

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {OPTIONS.map((opt) => (
        <Satellite
          key={opt.key}
          option={opt}
          menuProgress={menuProgress}
          highlighted={highlighted === opt.key}
        />
      ))}

      {open && highlighted && (
        <View style={styles.labelBubble} pointerEvents="none">
          <Text style={styles.labelText}>
            {OPTIONS.find((o) => o.key === highlighted)?.label}
          </Text>
        </View>
      )}

      <GestureDetector gesture={panGesture}>
        <Animated.View style={styles.button}>
          <Ionicons
            name={OPTIONS.find((o) => o.key === activeKey)?.icon || "camera"}
            size={24}
            color={BRAND.void}
          />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "flex-end",
    justifyContent: "flex-end",
    paddingBottom: ANCHOR_BOTTOM,
    paddingRight: ANCHOR_RIGHT,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    backgroundColor: BRAND.signal,
    borderColor: BRAND.danger,
    borderWidth: 2,
    borderRadius: BUTTON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: BRAND.signal,
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  satellite: {
    position: "absolute",
    bottom: ANCHOR_BOTTOM + BUTTON_SIZE / 2 - SATELLITE_SIZE / 2,
    right: ANCHOR_RIGHT + BUTTON_SIZE / 2 - SATELLITE_SIZE / 2,
    width: SATELLITE_SIZE,
    height: SATELLITE_SIZE,
    borderRadius: SATELLITE_SIZE / 2,
    backgroundColor: BRAND.surfaceRaised,
    borderWidth: 1,
    borderColor: BRAND.line,
    alignItems: "center",
    justifyContent: "center",
  },
  satelliteActive: {
    backgroundColor: BRAND.signal,
    borderColor: BRAND.signal,
  },
  labelBubble: {
    position: "absolute",
    bottom: ANCHOR_BOTTOM + BUTTON_SIZE + SATELLITE_RADIUS + 20,
    right: ANCHOR_RIGHT,
    backgroundColor: BRAND.surface,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: BRAND.line,
  },
  labelText: { color: BRAND.bone, fontSize: 12, fontWeight: "700" },
});
