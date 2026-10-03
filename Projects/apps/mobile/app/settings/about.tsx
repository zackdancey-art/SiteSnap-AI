import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import * as Application from "expo-application";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SettingsRow, SettingsDividerFull } from "@/components/SettingsRow";
import { SettingsBody, SettingsBodyStrong, SettingsCard, SettingsSection } from "@/components/SettingsSection";
import Colors from "@/constants/colors";

/**
 * About detail screen — reached from the About row on Settings.
 *
 * Product description and build identity, moved verbatim from the old combined
 * Settings screen.
 */
export default function AboutSettingsScreen() {
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

  return (
    <View style={styles.container}>
      <ScreenHeader title="About" paddingBottom={16} homeFallback="/(tabs)/settings" />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <SettingsSection>
          <SettingsCard>
            <SettingsBody>
              <SettingsBodyStrong>SiteSnap AI </SettingsBodyStrong>
              is a construction site-records app for builders and site managers. Capture daily site diaries, photos, incidents, deliveries, inspections and timesheets from the field, then generate clean, shareable PDF and Word reports. Built for how NZ and AU sites run.
            </SettingsBody>
            <SettingsDividerFull />
            <SettingsBody>
              <SettingsBodyStrong>Who makes it. </SettingsBodyStrong>
              SiteSnap AI Limited, NZBN 9429053872258, Christchurch, New Zealand.
              support@getsitesnapai.com
            </SettingsBody>
            <SettingsDividerFull />
            <SettingsBody>
              <SettingsBodyStrong>Still in testing. </SettingsBodyStrong>
              This build is distributed through TestFlight and has not been submitted to the App Store. Keep your own copies of anything you cannot afford to lose — the records screens will export to PDF or Word.
            </SettingsBody>
            <SettingsDividerFull />
            <SettingsRow icon="information-circle-outline" label="Version" value={versionLabel} />
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
  scrollContent: {
    paddingBottom: 48,
  },
});
