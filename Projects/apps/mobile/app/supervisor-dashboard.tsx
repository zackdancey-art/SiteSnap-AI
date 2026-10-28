import React, { useMemo } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { buildDiariesReportHtml, runReportExport } from "@/lib/export-utils";
import { canSeeSupervisorDashboard } from "@/lib/permissions";
import { siteStatusCfg } from "@/lib/siteStatus";
import { approvalTone } from "@/lib/portfolio-metrics";
import { usePortfolioSummary } from "@/lib/usePortfolioSummary";

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

/**
 * The portal's MetricCard, in React Native. Same four parts in the same order —
 * accent stripe, tinted icon chip, figure, label, optional sub-line — because
 * the two dashboards are meant to be the same dashboard.
 *
 * `value` is `number | string` for one reason: the em dash. A figure that has
 * not arrived is shown as "—", never as 0 and never as a number counted off the
 * capped bootstrap arrays.
 */
function MetricCard({ label, value, accent, iconBg, icon, sub }: {
  label: string;
  value: number | string;
  accent: string;
  iconBg: string;
  icon: string;
  sub?: string;
}) {
  return (
    <View style={[styles.metricCard, { borderLeftColor: accent }]}>
      <View style={[styles.metricIcon, { backgroundColor: iconBg }]}>
        <Text style={styles.metricIconGlyph}>{icon}</Text>
      </View>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
      {sub ? <Text style={styles.metricSub}>{sub}</Text> : null}
    </View>
  );
}

/** The portal's ProgressBar, clamped the same way. */
function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: color }]} />
    </View>
  );
}

/**
 * The three health colours, mapped from the tone rather than from a threshold
 * written again here. The portal's bar uses #22C55E / #F59E0B / #EF4444, which
 * are Colors.success / Colors.warning / Colors.error to the byte — see the
 * colour note in lib/siteStatus.ts.
 */
const TONE_COLOR = {
  good: Colors.success,
  fair: Colors.warning,
  poor: Colors.error,
} as const;

export default function SupervisorDashboardScreen() {
  const { sites, entries, diaries } = useData();
  const { user } = useAuth();
  // Kept even though (tabs)/_layout.tsx and app/_layout.tsx now REMOVE these
  // routes for anybody else rather than hiding their entry points. Two
  // independent checks is the point: a guard edited away in a layout should not
  // silently expose a screen, and the API refuses the data regardless.
  const canSeeSupervisor = canSeeSupervisorDashboard(user?.companyRole);

  /**
   * The figures are counted in the DATABASE, not in this component. AUDIT L98.
   *
   * This screen used to say its whole metrics surface in one sentence, measured
   * off the `useData()` arrays:
   *
   *     `${activeSites} active sites · ${entries.length} entries · ${diaries.length} diaries.`
   *
   * Those arrays come from `/projects/bootstrap`, which passes no limit to
   * `listSites`/`listEntries`/`listDiaries`, so each takes their default
   * `limit = 200`. A company with five thousand entries read "200 entries" on
   * the phone — the same defect the portal's dashboard had, from the same
   * cause, and it is why the portal's cards now call `/projects/summary`. This
   * surface is now the route's second caller.
   *
   * When that request has not succeeded the cards show an em dash rather than
   * falling back to the arrays, which are still right there. Falling back is the
   * tempting option and it is the wrong one: it would restore exactly the
   * silently-capped number this change exists to remove, on the one path nobody
   * tests. A missing number is visibly missing; a capped one is not.
   */
  const summary = usePortfolioSummary(canSeeSupervisor);
  const metrics = summary.status === "ok" ? summary.metrics : null;
  const metricsError = summary.status === "error" ? summary.message : "";

  // Every hook runs before the restricted-view return below. The early return
  // used to sit above this one, so a user whose companyRole changed between
  // renders changed the hook count for the same component — the condition React
  // reports as "rendered fewer hooks than expected" and then unmounts the tree
  // over. eslint-plugin-react-hooks is not installed in this repo and so did
  // not flag it; see the PR body.
  //
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

      {/* The portal's four cards, in the portal's order, with the portal's
          labels, accents and icons. Two per row at phone width. */}
      <View style={styles.metricsGrid}>
        <MetricCard
          label="Active Sites"
          value={metrics?.active ?? "—"}
          accent={Colors.success}
          iconBg={Colors.successBg}
          icon="🏗️"
          sub={metrics ? `${metrics.completed} completed` : undefined}
        />
        <MetricCard
          label="Total Entries"
          value={metrics?.entries ?? "—"}
          accent={Colors.primary}
          iconBg={Colors.infoBg}
          icon="📄"
        />
        <MetricCard
          label="Approved Diaries"
          value={metrics?.approved ?? "—"}
          accent={Colors.accent}
          iconBg={Colors.warningBg}
          icon="✅"
          sub={metrics ? `${metrics.approvalRate}% approval rate` : undefined}
        />
        <MetricCard
          label="Pending Review"
          value={metrics?.pending ?? "—"}
          accent={Colors.warning}
          iconBg={Colors.warningBg}
          icon="⏳"
        />
      </View>

      {metricsError ? (
        <Text style={styles.metricsError}>Portfolio totals are unavailable — {metricsError}</Text>
      ) : null}

      {/* Diary Approval Health, the portal's card, gated the same way: it is
          shown only when there is a denominator. */}
      {metrics && metrics.diaries > 0 ? (
        <View style={styles.healthCard}>
          <View style={styles.healthRow}>
            <Text style={styles.healthGlyph}>📊</Text>
            <Text style={styles.healthTitle}>Diary Approval Health</Text>
            <Text style={styles.healthPct}>{metrics.approvalRate}%</Text>
          </View>
          <ProgressBar value={metrics.approvalRate} color={TONE_COLOR[approvalTone(metrics.approvalRate)]} />
          <Text style={styles.healthSub}>
            {metrics.approved} of {metrics.diaries} diaries approved
          </Text>
        </View>
      ) : null}

      {/* The list below is the bootstrap payload, which is capped. Said out
          loud when the counted total is larger, rather than letting the screen
          imply these are all of them — the same line the portal's table
          header carries. */}
      <View style={styles.listHeaderRow}>
        <Text style={styles.listHeader}>Site Portfolio</Text>
        <Text style={styles.listCount}>{metrics?.sites ?? sites.length}</Text>
        {metrics && metrics.sites > sites.length ? (
          <Text style={styles.listShowing}>showing {sites.length}</Text>
        ) : null}
      </View>

      {orderedSites.length === 0 ? (
        <Text style={styles.emptyText}>No sites have been created yet.</Text>
      ) : (
        orderedSites.map(({ site, latestEntryDate, entryCount }) => {
          // One decision, in lib/siteStatus.ts, shared with the portal. This
          // line used to be `site.status.toUpperCase()`, which printed
          // "ON-HOLD" where every portal surface says "On Hold", in accent
          // orange whatever the status was.
          const cfg = siteStatusCfg(site.status);
          return (
            <Pressable
              key={site.id}
              style={styles.siteCard}
              onPress={() => router.push({ pathname: "/site/[id]", params: { id: site.id } })}
            >
              <View style={styles.siteCardTop}>
                <Text style={styles.siteName}>{site.name}</Text>
                <Text style={[styles.siteStatus, { color: cfg.color }]}>{cfg.label}</Text>
              </View>
              <Text style={styles.siteMeta}>{site.client}</Text>
              <Text style={styles.siteMeta}>{site.address}</Text>
              <Text style={styles.siteStats}>
                {recencyLabel(latestEntryDate)}
                {entryCount > 0 ? ` · ${countPhrase(entryCount, "entry", "entries")}` : ""}
              </Text>
            </Pressable>
          );
        })
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

  // Two cards per row, wrapping. `minWidth` rather than a fixed basis so the
  // pair still fits on the narrowest phone this app supports.
  metricsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metricCard: {
    flexGrow: 1,
    flexBasis: "46%",
    minWidth: 140,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderLeftWidth: 4,
    borderRadius: 14,
    padding: 12,
    gap: 2,
  },
  metricIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  metricIconGlyph: { fontSize: 15 },
  metricValue: { fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.text },
  metricLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  metricSub: { fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
  metricsError: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary },

  healthCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  healthRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  healthGlyph: { fontSize: 15 },
  healthTitle: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.text },
  healthPct: { fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.accent },
  healthSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.surfaceSecondary,
    overflow: "hidden",
  },
  progressFill: { height: 8, borderRadius: 4 },

  listHeaderRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  listHeader: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.text },
  listCount: { fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.accent },
  listShowing: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary },

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
  siteStatus: { fontSize: 11, fontFamily: "Inter_700Bold" },
  siteMeta: { fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  siteStats: { marginTop: 2, fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textTertiary },
});
