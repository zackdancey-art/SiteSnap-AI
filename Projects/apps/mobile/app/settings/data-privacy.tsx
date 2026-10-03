import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SettingsRow, SettingsDivider, SettingsDividerFull } from "@/components/SettingsRow";
import { SettingsBody, SettingsBodyStrong, SettingsCard, SettingsSection } from "@/components/SettingsSection";
import Colors from "@/constants/colors";

/**
 * Data & Privacy detail screen — reached from the Data & Privacy row on Settings.
 *
 * Carries the three data-handling statements verbatim from the old combined
 * Settings screen, plus the export / backup / policy rows. "Back up data" stays
 * here rather than moving next to Export: both are about getting your records
 * out of the app, and a user looking for either looks in the same place.
 *
 * There is deliberately no separate Legal screen. Privacy Policy and Terms of
 * Service are two rows; a screen holding two rows that each immediately push
 * again is a level of hierarchy that carries no information.
 */
export default function DataPrivacySettingsScreen() {
  return (
    <View style={styles.container}>
      <ScreenHeader title="Data & Privacy" paddingBottom={16} homeFallback="/(tabs)/settings" />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <SettingsSection description="Where your data lives and who can see it. Operated by SiteSnap AI Limited, NZBN 9429053872258.">
          <SettingsCard>
            <SettingsBody>
              <SettingsBodyStrong>Company-scoped access. </SettingsBodyStrong>
              Your company’s sites, diaries and records are isolated from every other company. This is enforced in the database with row-level security — not just hidden in the app — so a query can’t cross between companies.
            </SettingsBody>
            <SettingsDividerFull />
            <SettingsBody>
              <SettingsBodyStrong>Where it’s stored. </SettingsBodyStrong>
              The app and database run in Render’s Singapore region. Site photos and files are held in Amazon S3 in Sydney (ap-southeast-2).
            </SettingsBody>
            <SettingsDividerFull />
            <SettingsBody>
              <SettingsBodyStrong>Deletion & retention. </SettingsBodyStrong>
              Deleting a record removes it from your app straight away. The record itself is kept to meet construction and WorkSafe record-keeping requirements — it is marked deleted rather than erased.
            </SettingsBody>
            <SettingsDividerFull />
            <SettingsBody>
              <SettingsBodyStrong>Deleting your account. </SettingsBodyStrong>
              This removes your login and most of what is attached to it. Two things survive it, and the Privacy Policy sets out exactly which: the record of your uploads, and the photograph files themselves. Nothing in SiteSnap deletes a stored photograph — not on record delete, not on account delete, not on a schedule.
            </SettingsBody>
            <SettingsDividerFull />
            <SettingsBody>
              <SettingsBodyStrong>Getting a copy of your data. </SettingsBodyStrong>
              Email support@getsitesnapai.com with Privacy Request in the subject line and we will put it together by hand, within 20 working days. “Back up data” below saves what is cached on this phone; it is useful, but it is not a full copy of your records.
            </SettingsBody>
          </SettingsCard>
          {/*
            The Privacy Policy linked below is now written from the code audit rather than
            from assumption, and it names the operator: SiteSnap AI Limited, NZBN
            9429053872258. It still has NOT been reviewed by a lawyer — docs/legal/README.md
            records that and the trigger for getting it done — so nothing here or there
            asserts compliance with the Privacy Act 2020 or the Australian Privacy
            Principles. It describes what the software does and leaves the conclusion alone.
          */}
          <SettingsCard style={{ marginTop: 12 }}>
            <SettingsRow
              icon="download-outline"
              label="Export your data"
              description="Export diaries, dockets and reports as PDF or Word from the records screens."
              onPress={() => router.push("/export-diaries")}
            />
            <SettingsDivider />
            <SettingsRow
              icon="cloud-upload-outline"
              label="Back up data"
              description="Save what is cached on this phone. Not a full data export — see Privacy Policy."
              onPress={() => router.push("/backup-data")}
            />
            <SettingsDivider />
            <SettingsRow icon="shield-checkmark-outline" label="Privacy Policy" onPress={() => router.push("/privacy-policy")} />
            <SettingsDivider />
            <SettingsRow icon="document-text-outline" label="Terms of Service" onPress={() => router.push("/terms-of-service")} />
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
