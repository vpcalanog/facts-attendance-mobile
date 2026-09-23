import LogoMark from "@/components/logo-mark";
import { BRAND } from "@/constants/brand";
import { useAuth } from "@/context/auth-context";
import { userMessage } from "@/lib/errors";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";

export default function LoginScreen() {
  const { login, signedOutReason, clearSignedOutReason } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // `loading` alone can't stop a fast double tap: it only takes effect on
  // the next render, so both taps get past the check and fire two
  // sign-in requests.
  const submitting = useRef(false);

  async function handleLogin() {
    if (submitting.current) return;
    setError("");
    if (!username.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    submitting.current = true;
    setLoading(true);
    try {
      await login({
        username: username.trim(),
        password,
      });
      // No manual navigation needed — Stack.Protected in app/_layout.tsx
      // re-evaluates as soon as `user` changes and swaps to (tabs) itself.
    } catch (err) {
      setError(userMessage(err));
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  function onEdit(setter: (v: string) => void) {
    return (text: string) => {
      // Once they start typing, the "your session expired" banner has
      // served its purpose.
      if (signedOutReason) clearSignedOutReason();
      setter(text);
    };
  }

  return (
    <View style={styles.container}>
      {/* Radiating blades behind the mark — a quiet echo of the logo's own
          angular fins, not a literal copy of it. */}
      <View style={styles.rays} pointerEvents="none">
        <View
          style={[
            styles.ray,
            { left: "18%", transform: [{ rotate: "18deg" }], opacity: 0.14 },
          ]}
        />
        <View
          style={[
            styles.ray,
            { left: "38%", transform: [{ rotate: "8deg" }], opacity: 0.22 },
          ]}
        />
        <View
          style={[
            styles.ray,
            { left: "56%", transform: [{ rotate: "-4deg" }], opacity: 0.2 },
          ]}
        />
        <View
          style={[
            styles.ray,
            { left: "76%", transform: [{ rotate: "-16deg" }], opacity: 0.12 },
          ]}
        />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.brandBlock}>
          <LogoMark size={76} />
          <Text style={styles.brandTitle}>FACTS</Text>
          <Text style={styles.brandSubtitle}>ATTENDANCE SYSTEM</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.subtitle}>Sign in</Text>

          {signedOutReason ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>{signedOutReason}</Text>
            </View>
          ) : null}

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. amabini"
            placeholderTextColor={BRAND.smoke}
            autoCapitalize="none"
            autoCorrect={false}
            value={username}
            onChangeText={onEdit(setUsername)}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor={BRAND.smoke}
            secureTextEntry
            value={password}
            onChangeText={onEdit(setPassword)}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color={BRAND.void} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </TouchableOpacity>

          {/* <Text style={styles.hint}>
            Accounts are created by an admin on the server.
          </Text> */}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BRAND.void },
  flex: { flex: 1, justifyContent: "center", padding: 20 },
  rays: {
    position: "absolute",
    top: -40,
    left: 0,
    right: 0,
    height: 340,
    overflow: "hidden",
  },
  ray: {
    position: "absolute",
    top: -60,
    width: 3,
    height: 420,
    backgroundColor: BRAND.signal,
  },
  brandBlock: { alignItems: "center", marginBottom: 28 },
  brandTitle: {
    color: BRAND.bone,
    fontSize: 30,
    fontWeight: "900",
    letterSpacing: 6,
    marginTop: 14,
  },
  brandSubtitle: {
    color: BRAND.smoke,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 4,
    marginTop: 4,
  },
  card: {
    backgroundColor: BRAND.surface,
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: BRAND.line,
    overflow: "hidden",
  },
  subtitle: {
    fontSize: 13,
    color: BRAND.smoke,
    marginBottom: 18,
    fontWeight: "700",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  label: { fontSize: 13, color: BRAND.smoke, marginTop: 12, marginBottom: 4 },
  input: {
    backgroundColor: BRAND.void,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: BRAND.line,
    color: BRAND.bone,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  error: { color: BRAND.danger, marginTop: 14, fontSize: 13 },
  banner: {
    backgroundColor: BRAND.amberDim,
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
  },
  bannerText: { color: BRAND.bone, fontSize: 13 },
  button: {
    backgroundColor: BRAND.signal,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 20,
    shadowColor: BRAND.signal,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  buttonDisabled: { opacity: 0.7 },
  buttonText: {
    color: BRAND.void,
    fontWeight: "800",
    fontSize: 15,
    letterSpacing: 1,
  },
  hint: {
    color: BRAND.smoke,
    fontSize: 11,
    marginTop: 16,
    textAlign: "center",
  },
});
