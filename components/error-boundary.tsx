import { BRAND } from "@/constants/brand";
import { log } from "@/lib/logger";
import React from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

interface State {
  error: Error | null;
}

/**
 * Without this, any render-time throw takes the whole app to a blank
 * screen in a production build — on a device that may be holding the only
 * copy of unsynced attendance. The scans are safe in SQLite either way,
 * but the staff member needs a way back to them.
 */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    log.error("render error", {
      message: error.message,
      componentStack: info.componentStack?.slice(0, 500),
    });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.text}>
            Any attendance you have already logged is still saved on this device and will
            upload once the app is working again.
          </Text>
          {__DEV__ ? <Text style={styles.detail}>{error.message}</Text> : null}
          <TouchableOpacity
            style={styles.button}
            onPress={() => this.setState({ error: null })}
            activeOpacity={0.85}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.void },
  body: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 14 },
  title: { color: BRAND.bone, fontSize: 20, fontWeight: "800" },
  text: { color: BRAND.smoke, fontSize: 14, lineHeight: 20 },
  detail: {
    color: BRAND.amber,
    fontSize: 12,
    fontFamily: "SpaceMono",
    backgroundColor: BRAND.surface,
    borderRadius: 8,
    padding: 10,
  },
  button: {
    backgroundColor: BRAND.signal,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 6,
  },
  buttonText: { color: BRAND.void, fontWeight: "800", fontSize: 15 },
});
