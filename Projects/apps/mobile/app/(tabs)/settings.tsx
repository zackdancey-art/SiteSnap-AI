import React, { useState } from "react";
import {
  View,
  Text,
  Pressable,
  Switch,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
  Image,
  ActivityIndicator,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import Constants from "expo-constants";
import * as Application from "expo-application";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { DEFAULT_PROFILE, getLocalProfile } from "@/lib/profile-store";

interface SettingRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  value?: string;
  toggle?: boolean;
  toggleValue?: boolean;
  onToggle?: (val: boolean) => void;
  onPress?: () => void;
  danger?: boolean;
}

function SettingRow({ icon, label, description, value, toggle, toggleValue, onToggle, onPress, danger }: SettingRowProps) {
  const content = (
    <View style={styles.settingRow}>
      <View style={[styles.settingIcon, danger && { backgroundColor: Colors.error + "14" }]}>
        <Ionicons name={icon} size={20} color={danger ? Colors.error : Colors.accent} />
      </View>
      <View style={styles.settingLabelCol}>
        <Text style={[styles.settingLabelText, danger && { color: Colors.error }]}>{label}</Text>
        {!!description && <Text style={styles.settingDescription}>{description}</Text>}
      </View>
      {toggle && (
        <Switch
          value={toggleValue}
          onValueChange={onToggle}
          trackColor={{ false: Colors.border, true: Colors.accent + "66" }}
          thumbColor={toggleValue ? Colors.accent : Colors.textTertiary}
        />
      )}
      {!!value && <Text style={styles.settingValue}>{value}</Text>}
      {!toggle && !value && <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.7 }}>
        {content}
      </Pressable>
    );
  }
  return content;
}

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout, token } = useAuth();
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const roleLabel = user?.companyRole
    ? user.companyRole.charAt(0).toUpperCase() + user.companyRole.slice(1)
    : null;
  const [changingPassword, setChangingPassword] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;
  // Read the version and build number out of the NATIVE binary, not out of
  // expoConfig. eas.json sets `appVersionSource: "remote"`, so the build number
  // is assigned by EAS servers at build time and is not knowable to the config
  // that was evaluated on a developer's machine — `Constants.expoConfig` would
  // display a number that no TestFlight build ever carried. `nativeBuildVersion`
  // reads CFBundleVersion (iOS) / versionCode (Android) from the installed
  // binary, so this label matches what a tester sees in TestFlight by
  // construction rather than by us keeping two numbers in step.
  //
  // Both are null on web, and under Expo Go they describe the Expo Go binary
  // rather than this app — so fall back to the config values, which are at
  // least right about the version, and mark the build so nobody mistakes a
  // development reading for a real one.
  const extra = Constants.expoConfig?.extra as { appVersion?: string; buildVersion?: string } | undefined;
  const nativeVersion = Application.nativeApplicationVersion;
  const nativeBuild = Application.nativeBuildVersion;
  const versionLabel =
    nativeVersion && nativeBuild
      ? `${nativeVersion} (${nativeBuild})`
      : `${nativeVersion || extra?.appVersion || "0.0.0"} • ${extra?.buildVersion || "dev"}`;

  useFocusEffect(
    React.useCallback(() => {
      getLocalProfile().then(setProfile).catch(() => setProfile(DEFAULT_PROFILE));
    }, [])
  );

  const handleDeleteAccount = () => {
    Alert.alert(
      "Delete Account",
      "This will permanently delete your account and all your site data, entries, and reports. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete My Account",
          style: "destructive",
          onPress: async () => {
            setDeletingAccount(true);
            try {
              const { resolveApiBaseUrl } = await import("@/lib/api-base-url");
              const BASE_URL = resolveApiBaseUrl();
              const res = await fetch(`${BASE_URL}/api/auth/account`, {
                method: "DELETE",
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              });
              if (!res.ok) {
                const data = (await res.json()) as { error?: string };
                throw new Error(data.error || "Failed to delete account.");
              }
              await logout();
              router.replace("/login");
            } catch (err) {
              Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete account. Please try again.");
            } finally {
              setDeletingAccount(false);
            }
          },
        },
      ]
    );
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
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
      setChangingPassword(false);
      Alert.alert("Success", "Your password has been updated.");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to change password.");
    }
  };

  const handleLogout = () => {
    if (Platform.OS === "web") {
      logout();
      router.replace("/login");
      return;
    }
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: () => {
          logout();
          router.replace("/login");
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + webTopInset + 8 }]}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 100 + webBottomInset }}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.profileCard}>
          {profile.avatarUri ? (
            <Image source={{ uri: profile.avatarUri }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {user?.name?.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase() || "U"}
              </Text>
            </View>
          )}
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{user?.name || "User"}</Text>
            <Text style={styles.profileEmail}>{profile.jobTitle || user?.email || "user@example.com"}</Text>
          </View>
          <Pressable style={styles.editProfileButton} onPress={() => router.push("/profile")}>
            <Ionicons name="pencil-outline" size={18} color={Colors.accent} />
          </Pressable>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <Text style={styles.sectionDesc}>Your profile and how you sign in.</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              icon="person-outline"
              label="Edit profile"
              description="Your name, job title and contact details. These appear on the diaries, dockets and reports you generate."
              onPress={() => router.push("/profile")}
            />
            {roleLabel && (
              <>
                <View style={styles.divider} />
                <SettingRow icon="ribbon-outline" label="Role" description="Your access level in this company." value={roleLabel} />
              </>
            )}
            <View style={styles.divider} />
            <SettingRow
              icon="key-outline"
              label="Change password"
              description="Update the password you use to sign in."
              onPress={handleChangePassword}
            />
            {user?.companyRole === "owner" && (
              <>
                <View style={styles.divider} />
                <SettingRow
                  icon="person-add-outline"
                  label="Invite team member"
                  description="Add a manager, viewer or crew member to your company."
                  onPress={() => router.push("/company-invite")}
                />
              </>
            )}
          </View>
          {changingPassword && (
            <View style={[styles.sectionCard, { marginTop: 12, padding: 16, gap: 12 }]}>
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary }}>Current password</Text>
              <TextInput
                style={styles.pwInput} secureTextEntry value={pwCurrent}
                onChangeText={setPwCurrent} autoComplete="current-password" placeholder="Current password"
              />
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary }}>New password (min 8 chars)</Text>
              <TextInput
                style={styles.pwInput} secureTextEntry value={pwNew}
                onChangeText={setPwNew} autoComplete="new-password" placeholder="New password"
              />
              <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary }}>Confirm new password</Text>
              <TextInput
                style={styles.pwInput} secureTextEntry value={pwConfirm}
                onChangeText={setPwConfirm} autoComplete="new-password" placeholder="Confirm new password"
              />
              <Pressable style={styles.pwButton} onPress={submitPasswordChange}>
                <Text style={styles.pwButtonText}>Update Password</Text>
              </Pressable>
              <Pressable onPress={() => { setChangingPassword(false); setPwCurrent(""); setPwNew(""); setPwConfirm(""); }}>
                <Text style={{ textAlign: "center", fontSize: 13, color: Colors.textTertiary, paddingTop: 4 }}>Cancel</Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notifications</Text>
          <View style={styles.sectionCard}>
            <Text style={styles.cardBody}>
              Notifications are on by default. We’ll alert you when a diary is approved, a new site entry is added, or an incident is logged on one of your sites.
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data & Privacy</Text>
          <Text style={styles.sectionDesc}>Where your data lives and who can see it.</Text>
          <View style={styles.sectionCard}>
            <Text style={styles.cardBody}>
              <Text style={styles.cardBodyStrong}>Company-scoped access. </Text>
              Your company’s sites, diaries and records are isolated from every other company. This is enforced in the database with row-level security — not just hidden in the app — so a query can’t cross between companies.
            </Text>
            <View style={styles.dividerFull} />
            <Text style={styles.cardBody}>
              <Text style={styles.cardBodyStrong}>Where it’s stored. </Text>
              The app and database run in Render’s Singapore region. Site photos and files are held in Amazon S3 in Sydney (ap-southeast-2).
            </Text>
            <View style={styles.dividerFull} />
            <Text style={styles.cardBody}>
              <Text style={styles.cardBodyStrong}>Deletion & retention. </Text>
              Deleting a record removes it from your app straight away. A copy is kept for 7 years to meet construction and WorkSafe record-keeping requirements, then permanently purged.
            </Text>
          </View>
          {/* TODO(legal): add an NZ Privacy Act / AU Privacy Principles statement here once the Privacy Policy has been reviewed by a lawyer. Do NOT assert compliance until then. */}
          <View style={[styles.sectionCard, { marginTop: 12 }]}>
            <SettingRow icon="download-outline" label="Export your data" description="Export diaries, dockets and reports as PDF or Word from the records screens." onPress={() => router.push("/export-diaries")} />
            <View style={styles.divider} />
            <SettingRow icon="cloud-upload-outline" label="Back up data" description="Save a copy of your records to this device." onPress={() => router.push("/backup-data")} />
            <View style={styles.divider} />
            <SettingRow icon="shield-checkmark-outline" label="Privacy Policy" onPress={() => router.push("/privacy-policy")} />
            <View style={styles.divider} />
            <SettingRow icon="document-text-outline" label="Terms of Service" onPress={() => router.push("/terms-of-service")} />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Support</Text>
          <View style={styles.sectionCard}>
            <SettingRow
              icon="mail-outline"
              label="Contact support"
              description="Email support@getsitesnapai.com. Include your site name and what you were doing when the problem happened — it gets us to an answer faster."
              onPress={() => router.push("/help-support")}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.sectionCard}>
            <Text style={styles.cardBody}>
              <Text style={styles.cardBodyStrong}>SiteSnap AI </Text>
              is a construction site-records app for builders and site managers. Capture daily site diaries, photos, incidents, deliveries, inspections and timesheets from the field, then generate clean, shareable PDF and Word reports. Built for how NZ and AU sites run.
            </Text>
            <View style={styles.dividerFull} />
            <SettingRow icon="information-circle-outline" label="Version" value={versionLabel} />
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionCard}>
            <SettingRow icon="log-out-outline" label="Sign Out" onPress={handleLogout} danger />
            <View style={styles.divider} />
            {deletingAccount ? (
              <View style={styles.settingRow}>
                <ActivityIndicator size="small" color={Colors.error} style={{ marginRight: 12 }} />
                <Text style={[styles.settingLabel, { color: Colors.error }]}>Deleting account…</Text>
              </View>
            ) : (
              <SettingRow icon="trash-outline" label="Delete Account" onPress={handleDeleteAccount} danger />
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: Colors.white,
  },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    marginHorizontal: 16,
    marginTop: 20,
    padding: 16,
    borderRadius: 16,
    gap: 14,
    shadowColor: Colors.cardShadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 2,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImage: {
    width: 52,
    height: 52,
    borderRadius: 16,
  },
  avatarText: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.white,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  profileEmail: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginTop: 2,
  },
  editProfileButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderLeftColor: Colors.accent,
  },
  sectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    overflow: "hidden",
  },
  sectionDesc: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 19,
    marginTop: -2,
    marginBottom: 10,
    paddingLeft: 2,
  },
  cardBody: {
    fontSize: 14,
    color: Colors.text,
    lineHeight: 21,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardBodyStrong: {
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  settingLabelCol: {
    flex: 1,
    gap: 2,
  },
  settingLabelText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.text,
  },
  settingDescription: {
    fontSize: 12.5,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  dividerFull: {
    height: 1,
    backgroundColor: Colors.borderLight,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
  },
  settingLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.text,
  },
  settingValue: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textTertiary,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginLeft: 64,
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
});
