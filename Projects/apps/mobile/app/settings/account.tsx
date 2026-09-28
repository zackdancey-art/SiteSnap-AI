import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SettingsRow, SettingsDivider } from "@/components/SettingsRow";
import { SettingsCard, SettingsSection } from "@/components/SettingsSection";
import { useAuth } from "@/lib/auth-context";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";
import Colors from "@/constants/colors";

/**
 * Account detail screen — reached from the Account row on Settings.
 *
 * Holds what used to be the Account section of app/(tabs)/settings.tsx: profile
 * editing, the read-only company role, the inline change-password form, and the
 * owner-only team invite.
 *
 * The change-password form is guarded. On the old combined Settings screen a
 * half-filled password form could be lost by scrolling away or switching tabs
 * with nothing to lose but the typing; now that it lives behind a push it has a
 * back gesture and a back button, and useUnsavedChangesGuard covers both — it
 * also disables the iOS swipe-back while dirty, because a guard a swipe can
 * bypass is not a guard.
 */
export default function AccountSettingsScreen() {
  const { user, token } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");

  const roleLabel = user?.companyRole
    ? user.companyRole.charAt(0).toUpperCase() + user.companyRole.slice(1)
    : null;

  const isDirty = changingPassword && !!(pwCurrent || pwNew || pwConfirm);
  const markSaved = useUnsavedChangesGuard(isDirty);

  const clearPasswordForm = () => {
    setPwCurrent("");
    setPwNew("");
    setPwConfirm("");
  };

  const handleChangePassword = () => {
    Alert.alert(
      "Change Password",
      "Enter your current password and a new password (minimum 8 characters).",
      [{ text: "Continue", onPress: () => setChangingPassword(true) }, { text: "Cancel", style: "cancel" }]
    );
  };

  const submitPasswordChange = async () => {
    if (!pwCurrent) { Alert.alert("Error", "Current password is required."); return; }
    if (pwNew.length < 8) { Alert.alert("Error", "New password must be at least 8 characters."); return; }
    if (pwNew !== pwConfirm) { Alert.alert("Error", "New passwords do not match."); return; }
    try {
      const { resolveApiBaseUrl } = await import("@/lib/api-base-url");
      const BASE_URL = resolveApiBaseUrl();
      const res = await fetch(`${BASE_URL}/api/auth/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to change password.");
      }
      // Clear and mark saved BEFORE the alert: the guard must stop treating the
      // form as dirty the moment the change lands, or dismissing the success
      // alert and going back would prompt to discard an already-saved change.
      clearPasswordForm();
      setChangingPassword(false);
      markSaved();
      Alert.alert("Success", "Your password has been updated.");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to change password.");
    }
  };

  return (
    <View style={styles.container}>
      <ScreenHeader title="Account" paddingBottom={16} homeFallback="/(tabs)/settings" />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <SettingsSection description="Your profile and how you sign in.">
          <SettingsCard>
            <SettingsRow
              icon="person-outline"
              label="Edit profile"
              description="Your name, job title and contact details. These appear on the diaries, dockets and reports you generate."
              onPress={() => router.push("/profile")}
            />
            {roleLabel && (
              <>
                <SettingsDivider />
                <SettingsRow icon="ribbon-outline" label="Role" description="Your access level in this company." value={roleLabel} />
              </>
            )}
            <SettingsDivider />
            <SettingsRow
              icon="key-outline"
              label="Change password"
              description="Update the password you use to sign in."
              onPress={handleChangePassword}
            />
            {user?.companyRole === "owner" && (
              <>
                <SettingsDivider />
                <SettingsRow
                  icon="person-add-outline"
                  label="Invite team member"
                  description="Add a manager, viewer or crew member to your company."
                  onPress={() => router.push("/company-invite")}
                />
              </>
            )}
          </SettingsCard>

          {changingPassword && (
            <SettingsCard style={{ marginTop: 12, padding: 16, gap: 12 }}>
              <Text style={styles.pwLabel}>Current password</Text>
              <TextInput
                style={styles.pwInput} secureTextEntry value={pwCurrent}
                onChangeText={setPwCurrent} autoComplete="current-password" placeholder="Current password"
              />
              <Text style={styles.pwLabel}>New password (min 8 chars)</Text>
              <TextInput
                style={styles.pwInput} secureTextEntry value={pwNew}
                onChangeText={setPwNew} autoComplete="new-password" placeholder="New password"
              />
              <Text style={styles.pwLabel}>Confirm new password</Text>
              <TextInput
                style={styles.pwInput} secureTextEntry value={pwConfirm}
                onChangeText={setPwConfirm} autoComplete="new-password" placeholder="Confirm new password"
              />
              <Pressable style={styles.pwButton} onPress={submitPasswordChange}>
                <Text style={styles.pwButtonText}>Update Password</Text>
              </Pressable>
              <Pressable onPress={() => { setChangingPassword(false); clearPasswordForm(); }}>
                <Text style={styles.pwCancel}>Cancel</Text>
              </Pressable>
            </SettingsCard>
          )}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    paddingBottom: 48,
  },
  pwLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textSecondary,
  },
  pwInput: {
    height: 44,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    backgroundColor: Colors.background,
  },
  pwButton: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  pwButtonText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  pwCancel: {
    textAlign: "center",
    fontSize: 13,
    color: Colors.textTertiary,
    paddingTop: 4,
  },
});
