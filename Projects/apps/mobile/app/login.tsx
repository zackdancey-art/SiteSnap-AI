import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { isInputDebugEnabled, logInputEvent } from "@/lib/input-debug";

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login, lastEmail } = useAuth();
  /**
   * Where to go after a successful login.
   *
   * invite.tsx has always sent an unauthenticated invitee here with
   * `?next=/invite?token=…`, and this screen never read it — so the invitee
   * logged in and was dropped on the dashboard with the invitation silently
   * discarded. The parameter was being passed to nobody.
   *
   * Only internal paths are honoured. `next` arrives from a route parameter,
   * and a route parameter can arrive from a deep link, so an absolute URL here
   * would let a crafted link bounce a freshly-authenticated user somewhere of
   * the sender's choosing.
   */
  const { next } = useLocalSearchParams<{ next?: string }>();
  const safeNext = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [hasUserEditedEmail, setHasUserEditedEmail] = useState(false);
  const [didAutofillEmail, setDidAutofillEmail] = useState(false);

  useEffect(() => {
    // Autofill only once and only if user hasn't started typing.
    if (!didAutofillEmail && !hasUserEditedEmail && !email && lastEmail) {
      setEmail(lastEmail);
      setDidAutofillEmail(true);
    }
  }, [didAutofillEmail, email, hasUserEditedEmail, lastEmail]);

  const handleLogin = async () => {
    if (submitting) return;
    if (!email.trim()) {
      setError("Please enter your email");
      return;
    }
    if (!password.trim()) {
      setError("Please enter your password");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await login(email, password);
      router.replace(safeNext ?? "/(tabs)");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // An invitee who lands here and taps "Sign Up" must keep their invitation.
  // Without this the token dies at the login screen and the account is created
  // attached to nothing — the orphan state AUDIT L66 describes.
  const inviteTokenFromNext = (() => {
    if (!safeNext) return null;
    const m = /[?&]token=([^&]+)/.exec(safeNext);
    return m ? decodeURIComponent(m[1]) : null;
  })();

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const showDebugHint = isInputDebugEnabled();

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="always"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.logoSection}>
            <View style={styles.logoContainer}>
              <Image
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                source={require("../../../assets/images/splash-icon.png")}
                style={styles.logoImage}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.appName}>SiteSnap</Text>
            <Text style={styles.tagline}>Construction diary management</Text>
          </View>

          <View style={styles.formSection}>
            {!!error && (
              <View style={styles.errorBanner}>
                <View style={styles.errorIconWrap}>
                  <Ionicons name="warning" size={16} color={Colors.white} />
                </View>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            {showDebugHint && (
              <Text style={styles.debugHint}>Input diagnostics enabled</Text>
            )}

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="mail-outline" size={20} color={Colors.textTertiary} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="you@company.com"
                  placeholderTextColor={Colors.textTertiary}
                  value={email}
                  onChangeText={(value) => {
                    setHasUserEditedEmail(true);
                    setEmail(value);
                    logInputEvent("login.email", "change", value);
                  }}
                  onFocus={() => logInputEvent("login.email", "focus")}
                  onBlur={() => logInputEvent("login.email", "blur")}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="username"
                  returnKeyType="next"
                  testID="email-input"
                />
              </View>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={20} color={Colors.textTertiary} style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter password"
                  placeholderTextColor={Colors.textTertiary}
                  value={password}
                  onChangeText={(value) => {
                    setPassword(value);
                    logInputEvent("login.password", "change", value);
                  }}
                  onFocus={() => logInputEvent("login.password", "focus")}
                  onBlur={() => logInputEvent("login.password", "blur")}
                  secureTextEntry={!showPassword}
                  autoComplete="password"
                  textContentType="password"
                  returnKeyType="done"
                  testID="password-input"
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton}>
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={Colors.textTertiary} />
                </Pressable>
              </View>
            </View>

            <Pressable style={styles.forgotButton} onPress={() => router.push("/forgot-password")}>
              <Text style={styles.forgotText}>Forgot password?</Text>
            </Pressable>
            <Pressable style={styles.haveTokenButton} onPress={() => router.push("/reset-password")}>
              <Text style={styles.haveTokenText}>I already have a reset token</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [styles.loginButton, pressed && styles.loginButtonPressed]}
              onPress={handleLogin}
              testID="login-button"
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <>
                  <Text style={styles.loginButtonText}>Sign In</Text>
                  <Ionicons name="arrow-forward" size={20} color={Colors.white} />
                </>
              )}
            </Pressable>
          </View>

          <View style={[styles.footer, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 16) }]}>
            <Text style={styles.footerText}>Don't have an account?</Text>
            <Pressable
              onPress={() =>
                router.push(
                  inviteTokenFromNext
                    ? { pathname: "/signup", params: { inviteToken: inviteTokenFromNext } }
                    : "/signup"
                )
              }
            >
              <Text style={styles.signUpText}>Sign Up</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  logoSection: {
    alignItems: "center",
    marginBottom: 48,
  },
  logoContainer: {
    width: 80,
    height: 80,
    borderRadius: 24,
    backgroundColor: Colors.white,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 8,
  },
  logoImage: {
    width: "100%",
    height: "100%",
  },
  appName: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: Colors.primary,
    marginBottom: 4,
  },
  tagline: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
  },
  formSection: {
    gap: 16,
  },
  debugHint: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.textTertiary,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Colors.errorBg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.errorBorder,
  },
  errorIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.error,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.errorText,
  },
  inputGroup: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    marginLeft: 4,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    height: 52,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  eyeButton: {
    padding: 4,
  },
  forgotButton: {
    alignSelf: "flex-end",
  },
  forgotText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.accent,
  },
  haveTokenButton: {
    alignSelf: "flex-end",
    marginTop: -6,
  },
  haveTokenText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  loginButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.accent,
    height: 54,
    borderRadius: 14,
    marginTop: 8,
  },
  loginButtonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  loginButtonText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginTop: 32,
  },
  footerText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
  },
  signUpText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.accent,
  },
});
