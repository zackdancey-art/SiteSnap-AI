import React, { useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
  Image,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { authedFetch } from "@/lib/authed-fetch";
import { isSessionExpired } from "@/lib/session";
import { SettingsRow, SettingsDivider } from "@/components/SettingsRow";
import { SettingsCard, SettingsSection } from "@/components/SettingsSection";
import { TabScreenInsets, useTabScreenInsets } from "@/lib/useScreenInsets";
import Colors from "@/constants/colors";
import { DEFAULT_PROFILE, getLocalProfile } from "@/lib/profile-store";
import { useData } from "@/lib/data-context";

/**
 * Settings — a drill-down index, not a single long page.
 *
 * Account, Data & Privacy and About each own a screen under app/settings/; this
 * screen carries only the profile card, the rows that lead to them, and the two
 * destructive actions. Support is a direct row: it has exactly one destination
 * (/help-support), so a detail screen in between would add a tap and no
 * information.
 *
 * The Notifications section was DELETED rather than rewritten. It told users
 * "Notifications are on by default. We'll alert you when a diary is approved, a
 * new site entry is added, or an incident is logged" — none of which the app
 * does. There is no push registration anywhere in this package (no
 * getExpoPushTokenAsync, no requestPermissionsAsync, nothing POSTs to
 * /push/tokens), so no device ever has a token and no notification can arrive.
 * Of the three promised events only "incident logged" has any server-side
 * sender at all, and it notifies the reporter rather than supervisors. See
 * docs/AUDIT.md L21 (delivery half-built) and L20 (targeting bug). The section
 * comes back when notifications do.
 */
export default function SettingsScreen() {
  return (
    <TabScreenInsets>
      <SettingsContent />
    </TabScreenInsets>
  );
}

function SettingsContent() {
  const insets = useTabScreenInsets();
  const { user, logout } = useAuth();
  const { pendingCount, failedOps } = useData();
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [deletingAccount, setDeletingAccount] = useState(false);

  useFocusEffect(
    React.useCallback(() => {
      getLocalProfile().then(setProfile).catch(() => setProfile(DEFAULT_PROFILE));
    }, [])
  );

  const handleDeleteAccount = () => {
    Alert.alert(
      "Delete Account",
      // Says only what the server does. "Permanently delete … all your site data"
      // was the promise the audit flagged: nothing in the product deletes a
      // photograph from file storage, so the files outlive the account.
      "This deletes your account and the sites, entries and reports in it. It " +
        "cannot be undone.\n\nPhotographs you already uploaded are not removed " +
        "from our file storage. See the Privacy Policy.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete My Account",
          style: "destructive",
          onPress: async () => {
            setDeletingAccount(true);
            try {
              const res = await authedFetch("/api/auth/account", { method: "DELETE" });
              if (!res.ok) {
                const data = (await res.json()) as { error?: string };
                throw new Error(data.error || "Failed to delete account.");
              }
              await logout();
              router.replace("/login");
            } catch (err) {
              // The session ending mid-deletion is reported by lib/session.ts,
              // which routes to sign-in. Saying "Failed to delete account" as
              // well would blame the feature for the session.
              if (isSessionExpired(err)) return;
              Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete account. Please try again.");
            } finally {
              setDeletingAccount(false);
            }
          },
        },
      ]
    );
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
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <ScrollView
        // insets.bottom clears the tab bar (measured, see lib/useScreenInsets);
        // the +24 is breathing room below the last card, not a guess at the bar.
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
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

        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              icon="person-circle-outline"
              label="Account"
              description="Your profile and how you sign in."
              onPress={() => router.push("/settings/account")}
            />
            <SettingsDivider />
            <SettingsRow
              icon="lock-closed-outline"
              label="Data & Privacy"
              description="Where your data lives and who can see it."
              onPress={() => router.push("/settings/data-privacy")}
            />
            <SettingsDivider />
            {/* Rendered ONLY when there is something to show. The row used to be
                permanent and said "Everything on this phone has been sent." to
                almost everyone who ever opened Settings — a row whose usual
                content is that nothing is wrong is a row that teaches people to
                stop reading it, and it buried the one state that matters.

                Nothing is lost by hiding it: a failed sync still reaches the
                user through SyncStatusBanner on the sites list
                (app/(tabs)/index.tsx) without their going looking, and this row
                reappears the moment anything is pending or failed. AUDIT L30. */}
            {(failedOps.length > 0 || pendingCount > 0) && (
              <>
                <SettingsRow
                  icon={failedOps.length > 0 ? "alert-circle-outline" : "cloud-upload-outline"}
                  label="Offline Sync"
                  // The row says the count itself rather than only leading to
                  // it: "did not send" has to be legible without opening
                  // anything. AUDIT L30.
                  description={
                    failedOps.length > 0
                      ? `${failedOps.length} ${failedOps.length === 1 ? "item" : "items"} did not send.`
                      : `${pendingCount} ${pendingCount === 1 ? "item" : "items"} waiting for coverage.`
                  }
                  danger={failedOps.length > 0}
                  onPress={() => router.push("/settings/offline-sync")}
                />
                <SettingsDivider />
              </>
            )}
            <SettingsRow
              icon="mail-outline"
              label="Support"
              onPress={() => router.push("/help-support")}
            />
            <SettingsDivider />
            <SettingsRow
              icon="information-circle-outline"
              label="About"
              onPress={() => router.push("/settings/about")}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection>
          <SettingsCard>
            <SettingsRow icon="log-out-outline" label="Sign Out" onPress={handleLogout} danger />
            <SettingsDivider />
            {deletingAccount ? (
              <View style={styles.settingRow}>
                <ActivityIndicator size="small" color={Colors.error} style={{ marginRight: 12 }} />
                <Text style={styles.settingLabel}>Deleting account…</Text>
              </View>
            ) : (
              <SettingsRow icon="trash-outline" label="Delete Account" onPress={handleDeleteAccount} danger />
            )}
          </SettingsCard>
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
  // Only the "Deleting account…" placeholder row is still hand-rolled here: it
  // is a spinner rather than an icon, so it is not a SettingsRow.
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  settingLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.error,
  },
});
