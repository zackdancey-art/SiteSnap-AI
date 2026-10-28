import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SettingsBody, SettingsCard, SettingsSection } from "@/components/SettingsSection";
import { useData } from "@/lib/data-context";
import { describeFailure } from "@/lib/permissions";
import { describeBinAge } from "@/lib/bin-countdown";
import type { BinnedSite } from "@/lib/types";
import Colors from "@/constants/colors";

/**
 * The bin — the surface that makes "Delete Site" survivable.
 *
 * WHAT CHANGED UNDERNEATH IT
 *
 * `DELETE /projects/sites/:id` used to be a real delete, and because the nine
 * tables under `project_sites` all carry `ON DELETE CASCADE`, it took the
 * site's entries, diaries, templates, memberships, invites, timecards,
 * incidents, inspections and deliveries with it. Four of those tables have
 * their own soft delete, which the cascade went straight through: a timecard
 * marked deleted was recoverable and a timecard whose site was deleted was not.
 * This is a seven-year compliance product, and one tap on a phone was the only
 * thing standing in front of all of it.
 *
 * So the server now bins the site instead, and this screen is where it goes.
 * Without it the soft delete would be worse than the hard one: the records
 * would still exist and nobody holding the phone could reach them.
 *
 * WHY IT IS NOT IN THE SITES LIST
 *
 * A binned site is deliberately not a `Site` — see `BinnedSite` in lib/types.ts
 * — so there is no state in which a deleted site appears among the live ones
 * because a flag was not read. Restoring is rare and deliberate, which makes
 * Settings the honest place for it rather than a filter on the daily screen.
 *
 * WHY IT FETCHES ON FOCUS AND HOLDS NOTHING
 *
 * The decision made here is whether something still exists, and the countdown
 * shown next to it is the days remaining before it stops existing. A cached
 * answer to that is worse than no answer, so the list is fetched when the
 * screen is focused and discarded when it is not.
 *
 * ROLE GATE: the two routes behind this are `requireAtLeast("manager")`, the
 * same gate as deleting a site. The Settings entry that leads here is rendered
 * for manager and owner only (app/(tabs)/settings.tsx), and a 403 reaching this
 * screen anyway reads as a refusal rather than a broken feature, via
 * describeFailure().
 */
export default function SiteBinScreen() {
  const { listBinnedSites, restoreSite } = useData();
  const [sites, setSites] = useState<BinnedSite[] | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await listBinnedSites();
      setSites(response.sites);
      setRetentionDays(response.retentionDays);
      setError(null);
    } catch (err) {
      // An empty list and a failed fetch must not look the same: "nothing is in
      // the bin" and "we could not find out" lead to opposite decisions about
      // whether a site still exists. So the list stays null and the error shows.
      setSites(null);
      setError(describeFailure(err, "Could not load the bin."));
    }
    // Empty dependency list on purpose. `listBinnedSites` is redefined on every
    // render of the data provider, so depending on it would refetch on every
    // one of those -- and the identity of the function is not what this effect
    // is about. (react-hooks/exhaustive-deps is "off" in this workspace, so
    // there is no directive to suppress here; this comment is the reason, which
    // a directive would not have been.)
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      void load();
    }, [load])
  );

  const onRestore = (site: BinnedSite) => {
    Alert.alert(
      "Restore site",
      `Put "${site.name}" back? Its diary entries, photographs and records come back with it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restore",
          onPress: async () => {
            setRestoringId(site.id);
            try {
              await restoreSite(site.id);
              await load();
            } catch (err) {
              Alert.alert("Restore failed", describeFailure(err, "Could not restore this site."));
            } finally {
              setRestoringId(null);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      <ScreenHeader title="Deleted Sites" paddingBottom={16} homeFallback="/(tabs)/settings" />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {error !== null && (
          <SettingsSection>
            <SettingsCard>
              <View style={styles.statusRow}>
                <View style={[styles.statusIcon, { backgroundColor: Colors.errorBg }]}>
                  <Ionicons name="alert-circle-outline" size={20} color={Colors.errorText} />
                </View>
                <Text style={styles.statusText}>{error}</Text>
              </View>
            </SettingsCard>
          </SettingsSection>
        )}

        {error === null && sites === null && (
          <SettingsSection>
            <SettingsCard>
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={Colors.accent} />
                <Text style={styles.statusText}>Loading…</Text>
              </View>
            </SettingsCard>
          </SettingsSection>
        )}

        {sites !== null && sites.length === 0 && (
          <SettingsSection>
            <SettingsCard>
              <View style={styles.statusRow}>
                <View style={[styles.statusIcon, { backgroundColor: Colors.successBg }]}>
                  <Ionicons name="checkmark-circle-outline" size={20} color={Colors.successText} />
                </View>
                <Text style={styles.statusText}>No sites have been deleted.</Text>
              </View>
            </SettingsCard>
          </SettingsSection>
        )}

        {sites !== null && sites.length > 0 && (
          <SettingsSection title={sites.length === 1 ? "1 deleted site" : `${sites.length} deleted sites`}>
            <SettingsCard>
              {sites.map((site, index) => (
                <BinRow
                  key={site.id}
                  site={site}
                  retentionDays={retentionDays}
                  first={index === 0}
                  restoring={restoringId === site.id}
                  onRestore={() => onRestore(site)}
                />
              ))}
            </SettingsCard>
            {retentionDays !== null && (
              <SettingsBody>
                {`A deleted site and everything recorded on it stay here for ${retentionDays} days, ` +
                  `and can be put back at any point in that time. Nothing on this screen deletes anything.`}
              </SettingsBody>
            )}
          </SettingsSection>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * One binned site: what it was, when it went, and how long is left.
 *
 * The words come from lib/bin-countdown.ts, which is free of React Native
 * imports so that a test can execute them -- this screen cannot be
 * screenshotted from the build environment. The countdown itself comes from
 * the server (`daysInBin`), not from date arithmetic on the phone's clock.
 */
function BinRow({
  site,
  retentionDays,
  first,
  restoring,
  onRestore,
}: {
  site: BinnedSite;
  retentionDays: number | null;
  first: boolean;
  restoring: boolean;
  onRestore: () => void;
}) {
  return (
    <View style={[styles.binRow, !first && styles.binRowDivided]}>
      <View style={[styles.statusIcon, { backgroundColor: Colors.surfaceSecondary }]}>
        <Ionicons name="trash-outline" size={20} color={Colors.textSecondary} />
      </View>
      <View style={styles.binBody}>
        <Text style={styles.binTitle}>{site.name}</Text>
        {!!site.address && <Text style={styles.binMeta}>{site.address}</Text>}
        <Text style={styles.binMeta}>{describeBinAge(site, retentionDays)}</Text>
      </View>
      <Pressable
        onPress={onRestore}
        disabled={restoring}
        accessibilityRole="button"
        accessibilityLabel={`Restore ${site.name}`}
        style={({ pressed }) => [styles.restoreButton, (pressed || restoring) && { opacity: 0.6 }]}
      >
        {restoring ? (
          <ActivityIndicator size="small" color={Colors.accent} />
        ) : (
          <Text style={styles.restoreButtonText}>Restore</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { paddingBottom: 48 },
  statusRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  statusIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  statusText: { flex: 1, fontSize: 14, color: Colors.text, lineHeight: 20 },
  binRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  binRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  binBody: { flex: 1, gap: 2 },
  binTitle: { fontSize: 15, fontWeight: "600", color: Colors.text },
  binMeta: { fontSize: 12, color: Colors.textSecondary },
  // 44 is the iOS minimum tap target. AUDIT L51 is about controls below it, and
  // this one is new, so it starts above the line rather than joining the list.
  restoreButton: {
    minHeight: 44,
    minWidth: 76,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary,
  },
  restoreButtonText: { fontSize: 15, fontWeight: "600", color: Colors.accent },
});
