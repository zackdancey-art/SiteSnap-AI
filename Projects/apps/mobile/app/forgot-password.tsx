import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { apiRequest } from "@/lib/query-client";
import { isInputDebugEnabled, logInputEvent } from "@/lib/input-debug";
import { BackButton, goBackSafe } from "@/components/BackButton";
import { composeE164 } from "@/lib/phone";

const PREFIX_OPTIONS = [
  { label: "United States", code: "+1" },
  { label: "Australia", code: "+61" },
  { label: "New Zealand", code: "+64" },
  { label: "United Kingdom", code: "+44" },
  { label: "India", code: "+91" },
];

export default function ForgotPasswordScreen() {
  const insets = useSafeAreaInsets();
  const [identifier, setIdentifier] = useState("");
  const [smsPrefix, setSmsPrefix] = useState("+1");
  const [showPrefixModal, setShowPrefixModal] = useState(false);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [devReset, setDevReset] = useState<{ token: string; link: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function isValidEmail(email: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  const handleSend = async () => {
    if (submitting) return;
    if (!identifier.trim()) {
      setError(channel === "email" ? "Please enter your email address." : "Please enter your phone number.");
      return;
    }
    if (channel === "email" && !isValidEmail(identifier.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    const normalizedPhone = composeE164(smsPrefix, identifier);
    setError("");
    setMessage("");
    setDevReset(null);
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/auth/forgot-password", {
        identifier: channel === "sms" ? normalizedPhone : identifier.trim(),
        channel,
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        devResetToken?: string;
        devResetLink?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Unable to send reset instructions.");
      }
      setMessage(data.message || "Reset instructions sent.");
      if (data.devResetToken && data.devResetLink) {
        setDevReset({
          token: data.devResetToken,
          link: data.devResetLink,
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unable to send reset instructions.");
    } finally {
      setSubmitting(false);
    }
  };

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const showDebugHint = isInputDebugEnabled();

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      <BackButton tone="onLight" homeFallback="/login" style={{ position: "absolute", top: insets.top + 8, left: 12, zIndex: 10 }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="always">
          <View style={styles.logoSection}>
            <View style={styles.logoContainer}>
              <Ionicons name="key" size={34} color={Colors.white} />
            </View>
            <Text style={styles.appName}>Reset Password</Text>
            <Text style={styles.tagline}>We can send reset instructions by email or text</Text>
          </View>

          <View style={styles.formSection}>
            {!!error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={18} color={Colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {!!message && (
              <View style={styles.successBanner}>
                <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
                <Text style={styles.successText}>{message}</Text>
              </View>
            )}
            {showDebugHint && (
              <Text style={styles.debugHint}>Input diagnostics enabled</Text>
            )}
            {!!devReset && (
              <View style={styles.devCodeCard}>
                <Text style={styles.devCodeCardTitle}>Dev Mode — Reset Link</Text>
                <View style={styles.devCodeStack}>
                  <Text style={styles.devCodeLabel}>Reset token</Text>
                  <Text style={styles.devTokenValue} selectable>{devReset.token}</Text>
                </View>
                <View style={styles.devCodeStack}>
                  <Text style={styles.devCodeLabel}>Reset link</Text>
                  <Text style={styles.devTokenValue} selectable>{devReset.link}</Text>
                </View>
                <Pressable
                  style={styles.devResetAction}
                  onPress={() =>
                    router.push({
                      pathname: "/reset-password",
                      params: { token: devReset.token },
                    })
                  }
                >
                  <Ionicons name="create-outline" size={16} color={Colors.accent} />
                  <Text style={styles.devResetActionText}>Use Token Now</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.channelRow}>
              <Pressable
                style={[styles.channelChip, channel === "email" && styles.channelChipActive]}
                onPress={() => { setChannel("email"); setIdentifier(""); setMessage(""); setError(""); setDevReset(null); }}
              >
                <Text style={[styles.channelChipText, channel === "email" && styles.channelChipTextActive]}>Email</Text>
              </Pressable>
              <Pressable
                style={[styles.channelChip, channel === "sms" && styles.channelChipActive]}
                onPress={() => { setChannel("sms"); setIdentifier(""); setMessage(""); setError(""); setDevReset(null); }}
              >
                <Text style={[styles.channelChipText, channel === "sms" && styles.channelChipTextActive]}>Text (SMS)</Text>
              </Pressable>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>{channel === "email" ? "Email" : "Phone"}</Text>
              {channel === "email" ? (
                <TextInput
                  style={styles.input}
                  placeholder="you@company.com"
                  value={identifier}
                  onChangeText={(value) => {
                    setIdentifier(value);
                    logInputEvent("forgot.email", "change", value);
                  }}
                  onFocus={() => logInputEvent("forgot.email", "focus")}
                  onBlur={() => logInputEvent("forgot.email", "blur")}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  textContentType="emailAddress"
                />
              ) : (
                <View style={styles.phoneRow}>
                  <Pressable style={styles.prefixButton} onPress={() => setShowPrefixModal(true)}>
                    <Text style={styles.prefixButtonText}>{smsPrefix}</Text>
                    <Ionicons name="chevron-down" size={16} color={Colors.textSecondary} />
                  </Pressable>
                  <TextInput
                    style={[styles.input, styles.phoneInput]}
                    placeholder="5551234567"
                    value={identifier}
                    onChangeText={(value) => {
                      setIdentifier(value);
                      logInputEvent("forgot.phone", "change", value);
                    }}
                    onFocus={() => logInputEvent("forgot.phone", "focus")}
                    onBlur={() => logInputEvent("forgot.phone", "blur")}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    textContentType="telephoneNumber"
                  />
                </View>
              )}
            </View>

            <Pressable
              style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
              onPress={handleSend}
              disabled={submitting}
            >
              {submitting ? (
                <ActivityIndicator color={Colors.white} />
              ) : (
                <>
                  <Text style={styles.primaryButtonText}>Send Reset Instructions</Text>
                  <Ionicons name="send" size={18} color={Colors.white} />
                </>
              )}
            </Pressable>
          </View>

          <View style={[styles.footer, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 16) }]}>
            <Pressable onPress={() => goBackSafe("/login")}>
              <Text style={styles.linkText}>Back to Sign In</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showPrefixModal} transparent animationType="fade" onRequestClose={() => setShowPrefixModal(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowPrefixModal(false)}>
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Select country code</Text>
            <FlatList
              data={PREFIX_OPTIONS}
              keyExtractor={(item) => `${item.label}-${item.code}`}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.modalRow}
                  onPress={() => {
                    setSmsPrefix(item.code);
                    setShowPrefixModal(false);
                  }}
                >
                  <Text style={styles.modalRowLabel}>{item.label}</Text>
                  <Text style={styles.modalRowCode}>{item.code}</Text>
                </Pressable>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 24 },
  logoSection: { alignItems: "center", marginBottom: 32 },
  logoContainer: {
    width: 76,
    height: 76,
    borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  appName: { fontSize: 28, fontFamily: "Inter_700Bold", color: Colors.primary },
  tagline: { marginTop: 4, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  formSection: { gap: 14 },
  debugHint: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textTertiary },
  channelRow: { flexDirection: "row", gap: 8 },
  channelChip: {
    flex: 1,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: Colors.surface,
  },
  channelChipActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  channelChipText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary },
  channelChipTextActive: { color: Colors.white },
  inputGroup: { gap: 6 },
  label: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.text, marginLeft: 4 },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    height: 52,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  phoneRow: { flexDirection: "row", gap: 8 },
  prefixButton: {
    width: 92,
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  prefixButtonText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.text },
  phoneInput: { flex: 1 },
  primaryButton: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.accent,
    borderRadius: 14,
    height: 54,
  },
  primaryButtonPressed: { opacity: 0.9, transform: [{ scale: 0.98 }] },
  primaryButtonText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.white },
  footer: { marginTop: 26, flexDirection: "row", justifyContent: "center" },
  linkText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.accent },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.errorBg,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.errorBorder,
  },
  errorText: { fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.error },
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.successBg,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.successBorder,
  },
  successText: { fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.success },
  devCodeCard: {
    backgroundColor: Colors.infoBg,
    borderWidth: 1,
    borderColor: Colors.infoBorder,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  devCodeCardTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: Colors.infoText,
  },
  devCodeStack: {
    borderRadius: 10,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.infoBg,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  devCodeLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  devTokenValue: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.text, lineHeight: 18 },
  devResetAction: {
    marginTop: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 10,
    backgroundColor: Colors.white,
    paddingVertical: 10,
  },
  devResetActionText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.accent,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,43,70,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modalCard: {
    width: "100%",
    maxHeight: "70%",
    borderRadius: 16,
    padding: 14,
    backgroundColor: Colors.surface,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    marginBottom: 10,
  },
  modalRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalRowLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.text },
  modalRowCode: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.accent },
});
