import React, { useMemo } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { buildDiariesReportHtml, runReportExport } from "@/lib/export-utils";

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

export default function SupervisorDashboardScreen() {
  const { sites, entries, diaries } = useData();
  const { user } = useAuth();
  const canSeeSupervisor = user?.companyRole === "owner" || user?.companyRole === "manager";

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

  const metrics = useMemo(() => {
    const approvedDiaries = diaries.filter((diary) => diary.status === "approved").length;
    const draftDiaries = diaries.length - approvedDiaries;
    const activeSites = sites.filter((site) => site.status === "active").length;
    return { approvedDiaries, draftDiaries, activeSites };
  }, [diaries, sites]);

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
      <Text style={styles.heading}>Dashboard</Text>
      <Text style={styles.subheading}>Operations overview across all tracked sites and diaries.</Text>

      <View style={styles.metricsGrid}>
        <Metric label="Active Sites" value={metrics.activeSites} />
        <Metric label="Total Entries" value={entries.length} />
        <Metric label="Approved Diaries" value={metrics.approvedDiaries} />
        <Metric label="Draft Diaries" value={metrics.draftDiaries} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Actions</Text>
        <Pressable style={styles.actionButton} onPress={onExportReport}>
          <Text style={styles.actionButtonText}>Export Portfolio Report</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sites</Text>
        {sites.length === 0 ? (
          <Text style={styles.emptyText}>No sites have been created yet.</Text>
        ) : (
          sites.map((site) => {
            const siteEntryCount = entries.filter((entry) => entry.siteId === site.id).length;
            const siteDiaryCount = diaries.filter((diary) => diary.siteId === site.id).length;
            return (
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
                <Text style={styles.siteStats}>{siteEntryCount} entries • {siteDiaryCount} diaries</Text>
              </Pressable>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, gap: 14 },
  heading: { fontSize: 24, fontFamily: "Inter_700Bold", color: Colors.text },
  subheading: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  metricCard: {
    width: "48%",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 14,
    padding: 12,
    gap: 3,
  },
  metricValue: { fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.primary },
  metricLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  section: { gap: 8, marginTop: 2 },
  sectionTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.text },
  actionButton: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonText: { color: Colors.white, fontSize: 14, fontFamily: "Inter_600SemiBold" },
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
