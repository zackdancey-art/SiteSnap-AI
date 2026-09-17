import React, { useEffect, useMemo, useState } from "react";
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
import { BackButton, goBackSafe } from "@/components/BackButton";

type PrefixOption = {
  label: string;
  code: string;
};

const PREFIX_OPTIONS: PrefixOption[] = [
  { label: "United States", code: "+1" },
  { label: "Canada", code: "+1" },
  { label: "Australia", code: "+61" },
  { label: "New Zealand", code: "+64" },
  { label: "United Kingdom", code: "+44" },
  { label: "Ireland", code: "+353" },
  { label: "Singapore", code: "+65" },
  { label: "India", code: "+91" },
  { label: "South Africa", code: "+27" },
  { label: "United Arab Emirates", code: "+971" },
];

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeLocalPhone(phone: string) {
  return phone.replace(/\D/g, "");
}

export default function SignUpScreen() {
  const insets = useSafeAreaInsets();
  // Three stages, not two: the SMS is only minted once the email code is
  // accepted (API migration 029), so "check your email" and "check your phone"
  // are genuinely separate waits and cannot share a screen.
  const [step, setStep] = useState<"details" | "email" | "sms">("details");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phonePrefix, setPhonePrefix] = useState("+1");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [showPrefixModal, setShowPrefixModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [devCodes, setDevCodes] = useState<{ emailCode?: string; smsCode?: string } | null>(null);
  // Seconds left on the SMS resend cooldown, from the API's retryAfterSeconds.
  const [resendCooldown, setResendCooldown] = useState(0);

  const normalizedPhone = useMemo(
    () => `${phonePrefix}${normalizeLocalPhone(phoneLocal)}`,
    [phoneLocal, phonePrefix]
  );

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setTimeout(() => setResendCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(id);
  }, [resendCooldown]);

  /**
   * Send the user back to the start without making them retype anything.
   *
   * Reached when the pending signup is gone for good — expired, or burned
   * through its attempts. The name, email, phone and password stay in state
   * deliberately: they are already in memory (the form collected them and the
   * first request sent them), they are never written to storage, and clearing
   * them would cost a real user the longest field on the form to no benefit.
   */
  const restartFromDetails = (reason: string) => {
    setStep("details");
    setEmailCode("");
    setSmsCode("");
    setDevCodes(null);
    setResendCooldown(0);
    setMessage("");
    setError(reason);
  };

  const selectedPrefixLabel = useMemo(() => {
    const found = PREFIX_OPTIONS.find((item) => item.code === phonePrefix);
    return found ? `${found.label} (${found.code})` : phonePrefix;
  }, [phonePrefix]);

  const handleStartRegistration = async () => {
    if (submitting) return;
    if (!isValidEmail(email.trim())) {
      setError("Please enter a valid email address.");
      return;
    }
    if (!fullName.trim()) {
      setError("Please enter your full name.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (normalizeLocalPhone(phoneLocal).length < 8) {
      setError("Please enter a valid phone number.");
      return;
    }

    setError("");
    setMessage("");
    setDevCodes(null);
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/auth/register/initiate", {
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        phone: normalizedPhone,
        password,
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        devCodes?: { emailCode?: string };
      };
      if (!res.ok) {
        throw new Error(data.error || "Could not start registration.");
      }
      // No SMS has been sent at this point, and none will be until the email
      // code below comes back verified.
      setStep("email");
      setEmailCode("");
      setSmsCode("");
      setResendCooldown(0);
      setMessage(data.message || "We sent a code to your email.");
      setDevCodes(data.devCodes?.emailCode ? { emailCode: data.devCodes.emailCode } : null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not start registration.");
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Stage 2 — submit the email code. Success is what mints and sends the SMS,
   * so this is also the resend path: calling it again with the same accepted
   * code re-sends the existing SMS code under the server's cooldown, and never
   * mints a second one.
   */
  const handleVerifyEmail = async (options?: { resend?: boolean }) => {
    if (submitting) return;
    const code = emailCode.trim();
    if (!code) {
      setError("Enter the 6-digit code from your email.");
      return;
    }

    setError("");
    setMessage("");
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/auth/register/verify-email", {
        email: email.trim().toLowerCase(),
        emailCode: code,
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        restart?: boolean;
        retryAfterSeconds?: number;
        devCodes?: { smsCode?: string };
      };

      if (res.ok) {
        setStep("sms");
        setSmsCode("");
        setResendCooldown(0);
        setMessage(options?.resend ? "New code sent." : data.message || "We sent a code to your phone.");
        if (data.devCodes?.smsCode) {
          setDevCodes((prev) => ({ ...prev, smsCode: data.devCodes?.smsCode }));
        }
        return;
      }

      // The pending signup is gone for good — expired, or out of attempts.
      // Back to step 1 with everything they typed still in the form.
      if (data.restart) {
        restartFromDetails(data.error || "That signup expired. Please try again.");
        return;
      }

      // Cooldown. The code is already on its way, so move them forward rather
      // than stranding them on a step whose work is done, and count down the
      // resend button from the server's own number.
      if (res.status === 429 && typeof data.retryAfterSeconds === "number") {
        setStep("sms");
        setResendCooldown(data.retryAfterSeconds);
        setMessage("We already sent you a code. Check your messages.");
        return;
      }

      // Wrong code (401), or a transient 429/500/502. Stay put; clear the field
      // only when it was the field that was wrong.
      if (res.status === 401) setEmailCode("");
      setError(data.error || "Verification failed.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setSubmitting(false);
    }
  };

  /** Stage 3 — submit the SMS code and create the account. */
  const handleVerify = async () => {
    if (submitting) return;
    if (!smsCode.trim()) {
      setError("Enter the 6-digit code from the text message.");
      return;
    }

    setError("");
    setMessage("");
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/auth/register/verify", {
        email: email.trim().toLowerCase(),
        smsCode: smsCode.trim(),
      });
      const data = (await res.json()) as { error?: string; restart?: boolean; stage?: string };
      if (res.ok) {
        router.replace("/login");
        return;
      }
      if (data.restart) {
        restartFromDetails(data.error || "That signup expired. Please try again.");
        return;
      }
      // 409 + stage "email": the server has no verified email on file, so the
      // SMS step cannot be satisfied. Send them back one step rather than
      // letting them retype a code that can never match.
      if (data.stage === "email") {
        setStep("email");
        setSmsCode("");
        setError("Please enter your email code first.");
        return;
      }
      if (res.status === 401) setSmsCode("");
      setError(data.error || "Verification failed.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const webTopInset = Platform.OS === "web" ? 67 : 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
      <BackButton tone="onLight" homeFallback="/login" style={{ position: "absolute", top: insets.top + 8, left: 12, zIndex: 10 }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.logoSection}>
            <View style={styles.logoContainer}>
              <Ionicons
                name={step === "details" ? "person-add" : step === "email" ? "mail-open" : "chatbubble-ellipses"}
                size={36}
                color={Colors.white}
              />
            </View>
            <Text style={styles.appName}>
              {step === "details" ? "Create Account" : step === "email" ? "Check your email" : "Check your phone"}
            </Text>
            <Text style={styles.tagline}>
              {step === "details" ? (
                "We'll email you a code, then text you one"
              ) : (
                <>
                  We sent a 6-digit code to{" "}
                  <Text style={styles.taglineStrong}>
                    {step === "email" ? email.trim().toLowerCase() : normalizedPhone}
                  </Text>
                </>
              )}
            </Text>
          </View>

          <View style={styles.formSection}>
            {!!error && (
              <View style={styles.errorBanner}>
                <View style={styles.bannerIconWrapError}>
                  <Ionicons name="close-circle" size={18} color={Colors.white} />
                </View>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {!!message && (
              <View style={styles.successBanner}>
                <View style={styles.bannerIconWrapSuccess}>
                  <Ionicons name="checkmark" size={16} color={Colors.white} />
                </View>
                <Text style={styles.successText}>{message}</Text>
              </View>
            )}
            {!!devCodes && (
              <View style={styles.devCodeCard}>
                <Text style={styles.devCodeCardTitle}>Verification Codes (Dev)</Text>
                {!!devCodes.emailCode && (
                  <View style={styles.devCodeRow}>
                    <Text style={styles.devCodeLabel}>Email code</Text>
                    <Text style={styles.devCodeValue}>{devCodes.emailCode}</Text>
                  </View>
                )}
                {!!devCodes.smsCode && (
                  <View style={styles.devCodeRow}>
                    <Text style={styles.devCodeLabel}>SMS code</Text>
                    <Text style={styles.devCodeValue}>{devCodes.smsCode}</Text>
                  </View>
                )}
              </View>
            )}

            {step === "details" ? (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Full Name</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Jane Supervisor"
                    value={fullName}
                    onChangeText={setFullName}
                    autoCapitalize="words"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="you@company.com"
                    value={email}
                    onChangeText={setEmail}
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Phone</Text>
                  <View style={styles.phoneRow}>
                    <Pressable style={styles.prefixButton} onPress={() => setShowPrefixModal(true)}>
                      <Text style={styles.prefixButtonText}>{phonePrefix}</Text>
                      <Ionicons name="chevron-down" size={16} color={Colors.textSecondary} />
                    </Pressable>
                    <TextInput
                      style={[styles.input, styles.phoneInput]}
                      placeholder="5551234567"
                      value={phoneLocal}
                      onChangeText={setPhoneLocal}
                      keyboardType="phone-pad"
                    />
                  </View>
                  <Text style={styles.helperText}>{selectedPrefixLabel}</Text>
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Password</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Minimum 8 characters"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                  />
                </View>

                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Confirm Password</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Re-enter password"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
                  onPress={handleStartRegistration}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Send Verification Codes</Text>
                      <Ionicons name="mail-unread" size={20} color={Colors.white} />
                    </>
                  )}
                </Pressable>
              </>
            ) : step === "email" ? (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Email code</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="123456"
                    value={emailCode}
                    onChangeText={setEmailCode}
                    keyboardType="number-pad"
                    autoFocus
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
                  onPress={() => handleVerifyEmail()}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Continue</Text>
                      <Ionicons name="arrow-forward" size={20} color={Colors.white} />
                    </>
                  )}
                </Pressable>

                {/* Tell them the phone step is coming BEFORE it arrives, so a
                    second code isn't a surprise that reads like a failure. */}
                <Text style={styles.nextStepHint}>Next, we&apos;ll text a code to {normalizedPhone}</Text>

                <View style={styles.linkRow}>
                  <Pressable onPress={() => handleStartRegistration()} disabled={submitting}>
                    <Text style={styles.secondaryButtonText}>Resend email</Text>
                  </Pressable>
                  <Text style={styles.linkSeparator}>·</Text>
                  {/* Pure navigation — no request, so tapping it costs nothing. */}
                  <Pressable
                    onPress={() => {
                      setStep("details");
                      setEmailCode("");
                      setError("");
                      setMessage("");
                    }}
                    disabled={submitting}
                  >
                    <Text style={styles.secondaryButtonText}>Change email address</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>SMS code</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="123456"
                    value={smsCode}
                    onChangeText={setSmsCode}
                    keyboardType="number-pad"
                    autoFocus
                  />
                </View>

                <Pressable
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
                  onPress={handleVerify}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color={Colors.white} />
                  ) : (
                    <>
                      <Text style={styles.primaryButtonText}>Create account</Text>
                      <Ionicons name="checkmark-circle" size={20} color={Colors.white} />
                    </>
                  )}
                </Pressable>

                <View style={styles.linkRow}>
                  {/* Resend goes through verify-email, the cooldown path — NOT
                      initiate, which would restart the flow and bill a fresh
                      email send on every tap. */}
                  <Pressable
                    onPress={() => handleVerifyEmail({ resend: true })}
                    disabled={submitting || resendCooldown > 0}
                  >
                    <Text style={[styles.secondaryButtonText, resendCooldown > 0 && styles.linkDisabled]}>
                      {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend text"}
                    </Text>
                  </Pressable>
                  <Text style={styles.linkSeparator}>·</Text>
                  {/* Back to the email step, not to step 1: the pending signup
                      is still valid, and re-entering the email code lands on
                      the cooldown path rather than minting a second SMS. */}
                  <Pressable
                    onPress={() => {
                      setStep("email");
                      setSmsCode("");
                      setError("");
                      setMessage("");
                    }}
                    disabled={submitting}
                  >
                    <Text style={styles.secondaryButtonText}>Back</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>

          <View style={[styles.footer, { paddingBottom: insets.bottom + (Platform.OS === "web" ? 34 : 16) }]}>
            <Text style={styles.footerText}>Already have an account?</Text>
            <Pressable onPress={() => goBackSafe("/login")}>
              <Text style={styles.linkText}>Sign In</Text>
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
                    setPhonePrefix(item.code);
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
  tagline: { marginTop: 4, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary, textAlign: "center" },
  taglineStrong: { fontFamily: "Inter_600SemiBold", color: Colors.text },
  formSection: { gap: 14 },
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
  helperText: { marginLeft: 4, fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
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
  secondaryButtonText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.accent },
  linkRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 6 },
  linkSeparator: { fontSize: 14, color: Colors.textSecondary },
  linkDisabled: { color: Colors.textSecondary },
  nextStepHint: {
    marginTop: 12,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    color: Colors.textSecondary,
    textAlign: "center",
  },
  footer: { marginTop: 26, flexDirection: "row", justifyContent: "center", gap: 6 },
  footerText: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  linkText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.accent },
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
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Colors.successBg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.successBorder,
  },
  bannerIconWrapError: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.error,
    alignItems: "center",
    justifyContent: "center",
  },
  bannerIconWrapSuccess: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.success,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.errorText },
  successText: { flex: 1, fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.successText },
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
  devCodeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 10,
    backgroundColor: Colors.white,
    borderWidth: 1,
    borderColor: Colors.infoBg,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  devCodeLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  devCodeValue: { fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.infoText },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,43,70,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modalCard: {
    width: "100%",
    maxHeight: "75%",
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
