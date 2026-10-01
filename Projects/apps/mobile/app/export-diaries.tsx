import React, { useMemo } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useData } from "@/lib/data-context";
import Colors from "@/constants/colors";
import { buildDiariesReportHtml, buildDiariesCsv, runReportExport, shareOrDownloadText } from "@/lib/export-utils";

export default function ExportDiariesScreen() {
  const { diaries, sites } = useData();

  const exportHtml = useMemo(
    () => buildDiariesReportHtml(diaries, sites, "All Site Diaries", "Portfolio export across generated site diaries."),
    [diaries, sites]
  );

  // The try/catch this replaces alerted but reported nothing. runReportExport
  // does both, so every export in the app fails the same way.
  const onExport = async (format: "pdf" | "doc") => {
    await runReportExport({
      filenameBase: `sitesnap-diaries-${new Date().toISOString().slice(0, 10)}`,
      html: exportHtml,
      format,
      label: "the diaries",
    });
  };

  const onExportCsv = async () => {
    try {
      const csv = buildDiariesCsv(diaries, sites);
      await shareOrDownloadText(`sitesnap-diaries-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    } catch (error) {
      console.error("CSV export failed", error);
      Alert.alert("Export failed", "Could not export CSV.");
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Diary Export</Text>
        <Text style={styles.subtitle}>Export all generated diaries in a clean PDF, Word, or CSV report.</Text>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Diaries ready</Text>
          <Text style={styles.statValue}>{diaries.length}</Text>
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.buttonSecondary} onPress={() => void onExport("doc")}>
            <Text style={styles.buttonSecondaryText}>Word</Text>
          </Pressable>
          <Pressable style={styles.buttonSecondary} onPress={() => void onExportCsv()}>
            <Text style={styles.buttonSecondaryText}>CSV</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={() => void onExport("pdf")}>
            <Text style={styles.buttonText}>PDF</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16 },
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  title: { fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.text },
  subtitle: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: Colors.borderLight,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
    paddingVertical: 10,
  },
  statLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  statValue: { fontSize: 14, fontFamily: "Inter_700Bold", color: Colors.text },
  actions: { flexDirection: "row", gap: 10 },
  buttonSecondary: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  buttonSecondaryText: { color: Colors.accent, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  button: {
    flex: 1,
    backgroundColor: Colors.accent,
    borderRadius: 12,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: Colors.white, fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
