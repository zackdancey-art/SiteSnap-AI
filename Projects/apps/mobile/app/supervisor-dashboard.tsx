import React, { useMemo } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { buildDiariesReportHtml, runReportExport } from "@/lib/export-utils";

/** "2 entries", "1 entry", "no entries" — a count that reads as a sentence. */
function countPhrase(n: number, one: string, many: string) {
  if (n === 0) return `no ${many}`;
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Days between a YYYY-MM-DD entry date and today, as calendar days in local
 * time. Both sides are pinned to local midnight so a late-evening entry does
 * not read as "1 day ago" the moment the clock passes midnight-minus-an-hour.
 */
function daysAgo(ymd: string): number | null {
  const then = new Date(`${ymd}T00:00:00`);
  if (isNaN(then.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - then.getTime()) / 86400000);
}

function recencyLabel(latest: string | null): string {
  if (!latest) return "No entries yet";
  const days = daysAgo(latest);
  if (days === null) return "No entries yet";
  if (days <= 0) return "Last entry today";
  if (days === 1) return "Last entry yesterday";
  return `Last entry ${days} days ago`;
}

export default function SupervisorDashboardScreen() {
  const { sites, entries, diaries } = useData();
  const { user } = useAuth();
  const canSeeSupervisor = user?.companyRole === "owner" || user?.companyRole === "manager";

  // Every hook runs before the restricted-view return below. The early return
  // used to sit above this one, so a user whose companyRole changed between
  // renders changed the hook count for the same component — the condition React
  // reports as "rendered fewer hooks than expected" and then unmounts the tree
  // over. eslint-plugin-react-hooks is not installed in this repo and so did
  // not flag it; see the PR body.
  const summary = useMemo(() => {
    const activeSites = sites.filter((site) => site.status === "active").length;
    return (
      `${countPhrase(activeSites, "active site", "active sites")} · ` +
      `${countPhrase(entries.length, "entry", "entries")} · ` +
      `${countPhrase(diaries.length, "diary", "diaries")}.`
    );
  }, [sites, entries, diaries]);

  // The site list IS the body of this screen, so it carries the recency answer
  // and the ordering rather than a separate widget saying when anything
  // happened. Most recent first; a site with no entries sorts to the bottom.
  const orderedSites = useMemo(() => {
    const latestBySite = new Map<string, string>();
    for (const entry of entries) {
      const current = latestBySite.get(entry.siteId);
      if (!current || entry.date > current) latestBySite.set(entry.siteId, entry.date);
    }
    return sites
      .map((site) => ({
        site,
        latestEntryDate: latestBySite.get(site.id) ?? null,
        entryCount: entries.filter((entry) => entry.siteId === site.id).length,
      }))
      .sort((a, b) => {
        if (a.latestEntryDate === b.latestEntryDate) return a.site.name.localeCompare(b.site.name);
        if (!a.latestEntryDate) return 1;
        if (!b.latestEntryDate) return -1;
        return a.latestEntryDate < b.latestEntryDate ? 1 : -1;
      });
  }, [sites, entries]);

  if (!canSeeSupervisor) {
    return (
      <View style={[styles.container, styles.content]}>
        <Text style={styles.heading}>Access Restricted</Text>
        <Text style={styles.subheading}>
          Owner and manager accounts only.
        </Text>
      </View>
    );
  }

  const onExportReport = async () => {
    const html = buildDiariesReportHtml(
      diaries,
      sites,
      "Portfolio Report",
      "Operational snapshot across all tracked diaries and active projects."
    );
    Alert.alert("Export Report", "Choose an export format.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Word",
        onPress: () =>
          void runReportExport({
            filenameBase: `portfolio-report-${new Date().toISOString().slice(0, 10)}`,
            html,
            format: "doc",
            label: "the portfolio report",
          }),
      },
      {
        text: "PDF",
        onPress: () =>
          void runReportExport({
            filenameBase: `portfolio-report-${new Date().toISOString().slice(0, 10)}`,
            html,
            format: "pdf",
            label: "the portfolio report",
          }),
      },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* No in-body "Dashboard" heading: the native header already says it,
          and the two together cost ~40pt of the first screen. */}
      <Text style={styles.subheading}>Operations overview across all tracked sites and diaries.</Text>
      <Text style={styles.summary}>{summary}</Text>

      {orderedSites.length === 0 ? (
        <Text style={styles.emptyText}>No sites have been created yet.</Text>
      ) : (
        orderedSites.map(({ site, latestEntryDate, entryCount }) => (
          <Pressable
            key={site.id}
            style={styles.siteCard}
            onPress={() => router.push({ pathname: "/site/[id]", params: { id: site.id } })}
          >
            <View style={styles.siteCardTop}>
              <Text style={styles.siteName}>{site.name}</Text>
              <Text style={styles.siteStatus}>{site.status.toUpperCase()}</Text>
            </View>
            <Text style={styles.siteMeta}>{site.client}</Text>
            <Text style={styles.siteMeta}>{site.address}</Text>
            <Text style={styles.siteStats}>
              {recencyLabel(latestEntryDate)}
              {entryCount > 0 ? ` · ${countPhrase(entryCount, "entry", "entries")}` : ""}
            </Text>
          </Pressable>
        ))
      )}

      {/* Secondary, and at the bottom. It used to be the only accent-filled
          element on the screen, which made exporting look like the thing you
          came here to do. */}
      <Pressable style={styles.exportButton} onPress={onExportReport}>
        <Text style={styles.exportButtonText}>Export Portfolio Report</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, gap: 14 },
  heading: { fontSize: 24, fontFamily: "Inter_700Bold", color: Colors.text },
  subheading: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  summary: { fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.text, marginBottom: 2 },
  exportButton: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  exportButtonText: { color: Colors.primary, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  siteCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 14,
    padding: 12,
    gap: 4,
    marginBottom: 8,
  },
  siteCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  siteName: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.text, flex: 1, marginRight: 8 },
  siteStatus: { fontSize: 11, fontFamily: "Inter_700Bold", color: Colors.accent },
  siteMeta: { fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  siteStats: { marginTop: 2, fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textTertiary },
});
