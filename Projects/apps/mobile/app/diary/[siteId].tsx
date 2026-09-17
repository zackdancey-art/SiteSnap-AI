import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import { apiRequest, BASE_URL } from "@/lib/query-client";
import Colors from "@/constants/colors";
import { DailyEntry, GeneratedDiary, DiarySection, DiaryEditLogEntry, DiaryGeneration } from "@/lib/types";
import { describeGeneration } from "@/lib/provenance";
import { buildDiaryReportHtml, exportReportDocument, ReportExportFormat } from "@/lib/export-utils";
import { BackButton } from "@/components/BackButton";

type ReportPeriod = "daily" | "weekly" | "monthly";

const REPORT_OPTIONS: Array<{ key: ReportPeriod; label: string }> = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

function fallbackSectionFromEntry(entry: DailyEntry): DiarySection {
  const workNotes = entry.locationAddress
    ? `${entry.notes || "No notes provided."}\nLocation: ${entry.locationAddress}`
    : entry.notes || "No notes provided.";
  return {
    date: entry.date,
    weather: entry.weather || "Not recorded",
    crewCount: entry.crewCount || "Not recorded",
    workCompleted: workNotes,
    safetyObservations: "N/A",
    materialsUsed: "N/A",
    issues: "N/A",
    photoAnalysis: "N/A",
  };
}

function normalizeSection(section: Partial<DiarySection>): DiarySection {
  return {
    date: section.date || new Date().toISOString().slice(0, 10),
    weather: section.weather || "Not recorded",
    crewCount: section.crewCount || "Not recorded",
    workCompleted: section.workCompleted || "No work details provided.",
    safetyObservations: section.safetyObservations || "N/A",
    materialsUsed: section.materialsUsed || "N/A",
    issues: section.issues || "N/A",
    photoAnalysis: section.photoAnalysis || "N/A",
  };
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00`);
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function filterEntriesByPeriod(entries: DailyEntry[], period: ReportPeriod) {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => dateOnly(a.date).getTime() - dateOnly(b.date).getTime());
  const latest = dateOnly(sorted[sorted.length - 1].date);
  if (period === "daily") {
    const key = sorted[sorted.length - 1].date || formatDateKey(latest);
    return sorted.filter((entry) => entry.date === key);
  }
  if (period === "weekly") {
    const start = new Date(latest);
    start.setDate(start.getDate() - 6);
    return sorted.filter((entry) => dateOnly(entry.date) >= start && dateOnly(entry.date) <= latest);
  }
  return sorted.filter((entry) => {
    const d = dateOnly(entry.date);
    return d.getFullYear() === latest.getFullYear() && d.getMonth() === latest.getMonth();
  });
}

function getEntryActivityTime(entry: DailyEntry) {
  return new Date(entry.timestamp || entry.createdAt || `${entry.date}T23:59:59`).getTime();
}

function hasFreshDiaryForEntries(diary: GeneratedDiary | null, entries: DailyEntry[]) {
  if (!diary) return false;
  if (entries.length === 0) return true;
  const latestEntryTime = Math.max(...entries.map((entry) => getEntryActivityTime(entry)));
  return new Date(diary.generatedAt).getTime() >= latestEntryTime;
}

function shouldShowPhotoAnalysis(value: string) {
  return Boolean(value && value !== "N/A" && value !== "No photos attached for this entry");
}

function buildEntriesPayload(entries: DailyEntry[]) {
  return entries.map((entry) => ({
    date: entry.date,
    locationAddress: entry.locationAddress,
    weather: entry.weather,
    crewCount: entry.crewCount,
    notes: entry.notes,
    photos: entry.photos.map((photo) => ({
      id: photo.id,
      caption: photo.caption,
      timestamp: photo.timestamp,
      base64: photo.base64,
      mimeType: photo.mimeType,
    })),
  }));
}

export default function DiaryPreviewScreen() {
  const insets = useSafeAreaInsets();
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const data = useData();
  const { user } = useAuth();
  const safeSiteId = typeof siteId === "string" ? siteId : "";

  const site = safeSiteId ? data.getSite(safeSiteId) : undefined;
  const entries = safeSiteId ? data.getSiteEntries(safeSiteId) : [];
  const siteDiaries = safeSiteId ? data.getSiteDiaries(safeSiteId) : [];

  const [generating, setGenerating] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState<ReportPeriod>("daily");
  const [currentDiary, setCurrentDiary] = useState<GeneratedDiary | null>(null);
  const [isEditingReport, setIsEditingReport] = useState(false);
  const [editedSummary, setEditedSummary] = useState("");
  const [editedFullReport, setEditedFullReport] = useState("");

  const filteredEntries = useMemo(() => filterEntriesByPeriod(entries, selectedPeriod), [entries, selectedPeriod]);
  const totalPhotos = entries.reduce((sum, entry) => sum + entry.photos.length, 0);
  const latestMatchingDiary = useMemo(
    () => siteDiaries.find((diary) => (diary.reportPeriod || "daily") === selectedPeriod) || null,
    [siteDiaries, selectedPeriod]
  );

  useEffect(() => {
    if (!latestMatchingDiary) {
      setCurrentDiary(null);
      return;
    }
    setCurrentDiary(hasFreshDiaryForEntries(latestMatchingDiary, filteredEntries) ? latestMatchingDiary : null);
  }, [latestMatchingDiary, filteredEntries]);

  const visibleSections =
    currentDiary && currentDiary.sections.length > 0
      ? currentDiary.sections.map((section) => normalizeSection(section))
      : filteredEntries.map((entry) => fallbackSectionFromEntry(entry));

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  if (!safeSiteId || !site) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>{!safeSiteId ? "Missing site ID" : "Site not found"}</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.backLink}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const resolvedPeriod = currentDiary?.reportPeriod || selectedPeriod;
  const canApproveDiary = Boolean(user);
  const resolvedSummary =
    currentDiary?.summary?.trim() ||
    currentDiary?.fullReport?.split("\n").find((line) => line.trim()) ||
    `Generated from ${visibleSections.length} entr${visibleSections.length === 1 ? "y" : "ies"}.`;
  const resolvedFullReport = currentDiary?.fullReport?.trim() || "";
  const resolvedChecklist =
    currentDiary?.safetyChecklist && currentDiary.safetyChecklist.length > 0
      ? currentDiary.safetyChecklist
      : [];

  const handleGenerate = async () => {
    if (filteredEntries.length === 0) {
      Alert.alert("No Entries", `No ${selectedPeriod} entries available to generate a diary.`);
      return;
    }

    setGenerating(true);
    try {
      console.log(`[diary] Generate request URL: ${BASE_URL}/api/generate-diary`);
      let res = await apiRequest("POST", "/api/generate-diary", {
        siteId: safeSiteId,
        period: selectedPeriod,
      });
      let payload = (await res.json()) as {
        success?: boolean;
        error?: string;
        // Signed provenance from the API. Previously this response type didn't
        // declare `warning` at all, so a report written by the template
        // generator instead of the AI arrived looking identical to one the AI
        // wrote — the downgrade was invisible to the user and to this code.
        generation?: DiaryGeneration;
        warning?: string;
        diary?: {
          summary?: string;
          fullReport?: string;
          safetyChecklist?: string[];
          reportPeriod?: ReportPeriod;
          sections?: Array<Partial<DiarySection>>;
        };
      };

      const shouldRetryWithLocalEntries =
        !res.ok &&
        typeof payload.error === "string" &&
        /(No entries are available|Site not found)/i.test(payload.error);

      if (shouldRetryWithLocalEntries) {
        res = await apiRequest("POST", "/api/generate-diary", {
          period: selectedPeriod,
          site: {
            name: site.name,
            client: site.client,
            address: site.address,
            startDate: site.startDate,
          },
          entries: buildEntriesPayload(filteredEntries),
        });
        payload = (await res.json()) as typeof payload;
      }

      if (!res.ok || !payload.success || !payload.diary) {
        Alert.alert("Error", payload.error || "Failed to generate diary.");
        return;
      }

      const apiSections = Array.isArray(payload.diary.sections) ? payload.diary.sections : [];
      const normalizedSections =
        apiSections.length > 0
          ? apiSections.map((section) => normalizeSection(section))
          : filteredEntries.map((entry) => fallbackSectionFromEntry(entry));
      const diary = data.addDiary({
        siteId: safeSiteId,
        status: "draft",
        summary: payload.diary.summary || "",
        reportPeriod: payload.diary.reportPeriod || selectedPeriod,
        fullReport: payload.diary.fullReport || "",
        safetyChecklist: Array.isArray(payload.diary.safetyChecklist) ? payload.diary.safetyChecklist : [],
        sections: normalizedSections,
        // Passed through to the save request, where the API verifies the
        // signature before storing it. Unsigned or tampered provenance is
        // stored as NULL ("unknown"), never as the generator it claimed.
        generation: payload.generation ?? null,
      });
      setCurrentDiary(diary);
    } catch (err: unknown) {
      console.warn("Generate diary error:", err);
      const message =
        err instanceof Error && err.message.includes("Network request failed")
          ? "Couldn't connect to SiteSnap AI. Check your internet connection and try again."
          : err instanceof Error && err.message
            ? err.message
            : "Could not connect to report generation. Please try again.";
      Alert.alert("Error", message);
    } finally {
      setGenerating(false);
    }
  };

  const appendEditLog = (diary: GeneratedDiary, entry: DiaryEditLogEntry): GeneratedDiary => ({
    ...diary,
    editLog: [...(diary.editLog ?? []), entry],
  });

  const handleApprove = () => {
    if (!currentDiary) return;
    const logEntry: DiaryEditLogEntry = {
      at: new Date().toISOString(),
      action: "approved",
      by: user?.email,
    };
    const updated = appendEditLog({ ...currentDiary, status: "approved" }, logEntry);
    data.updateDiary(currentDiary.id, { status: "approved", editLog: updated.editLog });
    setCurrentDiary(updated);
    Alert.alert("Approved", "Diary has been marked as approved and locked for editing.");
  };

  const handleRevertToDraft = () => {
    if (!currentDiary) return;
    Alert.prompt(
      "Revert to Draft",
      "Approved reports are locked. Enter a reason to re-open this diary for editing (required for audit trail):",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Re-open",
          onPress: (reason?: string) => {
            if (!reason?.trim()) {
              Alert.alert("Reason required", "Please enter a reason to revert this approved diary.");
              return;
            }
            const logEntry: DiaryEditLogEntry = {
              at: new Date().toISOString(),
              action: "reverted",
              by: user?.email,
              note: reason.trim(),
            };
            const updated = appendEditLog({ ...currentDiary, status: "draft" }, logEntry);
            data.updateDiary(currentDiary.id, { status: "draft", editLog: updated.editLog });
            setCurrentDiary(updated);
          },
        },
      ],
      "plain-text"
    );
  };

  const handleStartEditReport = () => {
    if (!currentDiary) return;
    setEditedSummary(resolvedSummary);
    setEditedFullReport(resolvedFullReport);
    setIsEditingReport(true);
  };

  const handleSaveReportEdits = () => {
    if (!currentDiary) return;
    const logEntry: DiaryEditLogEntry = {
      at: new Date().toISOString(),
      action: "edited",
      by: user?.email,
    };
    const updated = appendEditLog(
      { ...currentDiary, summary: editedSummary, fullReport: editedFullReport },
      logEntry
    );
    data.updateDiary(currentDiary.id, {
      summary: editedSummary,
      fullReport: editedFullReport,
      editLog: updated.editLog,
    });
    setCurrentDiary(updated);
    setIsEditingReport(false);
  };

  const generateShareText = () => {
    if (!currentDiary) return "";
    const lines = [
      `SITE DIARY - ${site.name}`,
      "=".repeat(44),
      `Client: ${site.client}`,
      `Address: ${site.address}`,
      `Report Period: ${resolvedPeriod.toUpperCase()}`,
      `Generated: ${new Date(currentDiary.generatedAt).toLocaleString("en-AU")}`,
      `Status: ${currentDiary.status.toUpperCase()}`,
      `Generator: ${describeGeneration(currentDiary.generation).label}`,
      "",
      "EXECUTIVE SUMMARY",
      resolvedSummary,
      "",
    ];
    if (resolvedFullReport) {
      lines.push("FULL REPORT");
      lines.push(resolvedFullReport);
      lines.push("");
    }
    lines.push("SAFETY CHECKLIST");
    resolvedChecklist.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
    lines.push("");

    visibleSections.forEach((section) => {
      lines.push("-".repeat(44));
      lines.push(`Date: ${section.date}`);
      lines.push(`Weather: ${section.weather}`);
      lines.push(`Crew: ${section.crewCount}`);
      lines.push(`Work: ${section.workCompleted}`);
      if (section.safetyObservations !== "N/A") lines.push(`Safety: ${section.safetyObservations}`);
      if (section.materialsUsed !== "N/A") lines.push(`Materials: ${section.materialsUsed}`);
      if (section.issues !== "N/A") lines.push(`Issues: ${section.issues}`);
      if (section.photoAnalysis !== "No photos attached for this entry") lines.push(`Photo Notes: ${section.photoAnalysis}`);
      lines.push("");
    });
    return lines.join("\n");
  };

  const runExport = async (format: ReportExportFormat) => {
    if (!currentDiary) {
      Alert.alert("Nothing to export", "Generate a diary before exporting.");
      return;
    }
    try {
      const html = buildDiaryReportHtml({
        diary: { ...currentDiary, sections: visibleSections },
        site,
        summary: resolvedSummary,
        fullReport: resolvedFullReport,
        checklist: resolvedChecklist,
      });
      await exportReportDocument({
        filenameBase: `${site.name}-${resolvedPeriod}-site-diary-${new Date(currentDiary.generatedAt).toISOString().slice(0, 10)}`,
        html,
        format,
        fallbackText: generateShareText(),
      });
    } catch (err) {
      console.warn("Export diary failed", err);
      Alert.alert("Export Failed", "Could not export this diary.");
    }
  };

  const handleShare = async () => {
    Alert.alert("Export Diary", "Choose an export format.", [
      { text: "Cancel", style: "cancel" },
      { text: "Word", onPress: () => void runExport("doc") },
      { text: "PDF", onPress: () => void runExport("pdf") },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + webTopInset + 8 }]}>
        <View style={styles.headerNav}>
          <BackButton tone="onNavy" glyph="arrow-back" size={22} style={styles.backButton} />
          <Text style={styles.headerLabel}>Site Diary</Text>
          <Pressable onPress={handleShare} style={styles.shareButton}>
            <Ionicons name="share-outline" size={20} color={Colors.white} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: 40 + webBottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.diaryHeader}>
          <View style={styles.diaryBadge}>
            <Ionicons name="book" size={18} color={Colors.accent} />
          </View>
          <Text style={styles.diaryTitle}>{site.name}</Text>
          <Text style={styles.diarySubtitle}>{site.client}</Text>
          <Text style={styles.diaryAddress}>{site.address}</Text>
          <View style={styles.diaryDateRange}>
            <Text style={styles.diaryDateText}>
              Started {new Date(site.startDate).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
            </Text>
            <View style={styles.diaryDot} />
            <Text style={styles.diaryDateText}>{entries.length} entries</Text>
          </View>
        </View>

        <Pressable
          style={styles.galleryButton}
          onPress={() => router.push({ pathname: "/diary-gallery/[siteId]", params: { siteId: safeSiteId } })}
        >
          <Ionicons name="images" size={18} color={Colors.primary} />
          <Text style={styles.galleryButtonText}>Gallery ({totalPhotos} photos)</Text>
          <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
        </Pressable>

        {!currentDiary && (
          <View style={styles.generatePanel}>
            <Text style={styles.periodTitle}>Report Period</Text>
            <View style={styles.periodRow}>
              {REPORT_OPTIONS.map((option) => (
                <Pressable
                  key={option.key}
                  style={[styles.periodChip, selectedPeriod === option.key && styles.periodChipActive]}
                  onPress={() => setSelectedPeriod(option.key)}
                >
                  <Text style={[styles.periodChipText, selectedPeriod === option.key && styles.periodChipTextActive]}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.periodHint}>
              {filteredEntries.length} entr{filteredEntries.length === 1 ? "y" : "ies"} will be included.
            </Text>
            <Pressable
              style={[styles.generateButton, generating && styles.generateButtonDisabled]}
              onPress={handleGenerate}
              disabled={generating}
            >
              {generating ? (
                <>
                  <ActivityIndicator size="small" color={Colors.white} />
                  <Text style={styles.generateButtonText}>Generating report...</Text>
                </>
              ) : (
                <>
                  <Ionicons name="sparkles" size={20} color={Colors.white} />
                  <Text style={styles.generateButtonText}>
                    Generate {selectedPeriod} Report
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        )}

        {currentDiary && (
          <View style={styles.aiDiaryContainer}>
            <View style={styles.statusBar}>
              <View style={[styles.statusBadge, currentDiary.status === "approved" ? styles.statusApproved : styles.statusDraft]}>
                <Ionicons
                  name={currentDiary.status === "approved" ? "checkmark-circle" : "time-outline"}
                  size={14}
                  color={currentDiary.status === "approved" ? Colors.success : Colors.warning}
                />
                <Text style={[styles.statusText, currentDiary.status === "approved" ? styles.statusTextApproved : styles.statusTextDraft]}>
                  {currentDiary.status === "approved" ? "APPROVED" : "DRAFT - Review Required"}
                </Text>
              </View>
              <Text style={styles.generatedDate}>
                {resolvedPeriod.toUpperCase()} •{" "}
                {new Date(currentDiary.generatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
              </Text>
            </View>

            {/* Provenance banner. A banner rather than a toast on purpose: a
                toast is gone before anyone reads the report, and "did AI write
                this?" is a question asked of the document, not of the moment it
                was generated. Rendered from the STORED provenance, so it is
                still there when the report is reopened next month. */}
            {(() => {
              const p = describeGeneration(currentDiary.generation);
              const tint =
                p.tone === "ai" ? Colors.success : p.tone === "fallback" ? Colors.warning : Colors.textTertiary;
              return (
                <View style={[styles.provenanceBanner, { backgroundColor: tint + "14", borderLeftColor: tint }]}>
                  <Ionicons
                    name={p.tone === "ai" ? "sparkles" : p.tone === "fallback" ? "warning-outline" : "help-circle-outline"}
                    size={16}
                    color={tint}
                  />
                  <View style={styles.provenanceTextWrap}>
                    <Text style={[styles.provenanceLabel, { color: tint }]}>{p.label}</Text>
                    {p.detail ? <Text style={styles.provenanceDetail}>{p.detail}</Text> : null}
                  </View>
                </View>
              );
            })()}

            <View style={styles.summaryCard}>
              <View style={styles.summaryHeader}>
                <Ionicons name="analytics" size={16} color={Colors.accent} />
                <Text style={styles.summaryLabel}>Executive Summary</Text>
                {currentDiary.status === "draft" && !isEditingReport && (
                  <Pressable onPress={handleStartEditReport} style={styles.editChip}>
                    <Ionicons name="create-outline" size={13} color={Colors.accent} />
                    <Text style={styles.editChipText}>Edit</Text>
                  </Pressable>
                )}
              </View>
              {isEditingReport ? (
                <TextInput
                  style={styles.editTextArea}
                  value={editedSummary}
                  onChangeText={setEditedSummary}
                  multiline
                  textAlignVertical="top"
                  autoFocus
                />
              ) : (
                <Text style={styles.summaryText}>{resolvedSummary}</Text>
              )}
            </View>

            {(!!resolvedFullReport || isEditingReport) && (
              <View style={styles.summaryCard}>
                <View style={styles.summaryHeader}>
                  <Ionicons name="document-text" size={16} color={Colors.primary} />
                  <Text style={styles.summaryLabel}>Full Report</Text>
                </View>
                {isEditingReport ? (
                  <>
                    <TextInput
                      style={[styles.editTextArea, styles.editTextAreaLarge]}
                      value={editedFullReport}
                      onChangeText={setEditedFullReport}
                      multiline
                      textAlignVertical="top"
                    />
                    <View style={styles.editActions}>
                      <Pressable style={styles.editCancelBtn} onPress={() => setIsEditingReport(false)}>
                        <Text style={styles.editCancelText}>Cancel</Text>
                      </Pressable>
                      <Pressable style={styles.editSaveBtn} onPress={handleSaveReportEdits}>
                        <Ionicons name="checkmark" size={15} color={Colors.white} />
                        <Text style={styles.editSaveText}>Save edits</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <Text style={styles.summaryText}>{resolvedFullReport}</Text>
                )}
              </View>
            )}

            <View style={styles.summaryCard}>
              <View style={styles.summaryHeader}>
                <Ionicons name="shield-checkmark" size={16} color={Colors.success} />
                <Text style={styles.summaryLabel}>Safety Checklist</Text>
              </View>
              {resolvedChecklist.map((item, index) => (
                <View key={`${item}-${index}`} style={styles.checklistRow}>
                  <Ionicons name="checkmark-circle" size={16} color={Colors.success} />
                  <Text style={styles.checklistText}>{item}</Text>
                </View>
              ))}
            </View>

            {visibleSections.map((section, idx) => (
              <SectionCard key={`${section.date}-${idx}`} section={section} index={idx} />
            ))}

            {currentDiary.editLog && currentDiary.editLog.length > 0 && (
              <View style={styles.summaryCard}>
                <View style={styles.summaryHeader}>
                  <Ionicons name="time-outline" size={16} color={Colors.textSecondary} />
                  <Text style={styles.summaryLabel}>Audit Trail</Text>
                </View>
                {currentDiary.editLog.map((log, idx) => (
                  <View key={idx} style={styles.auditRow}>
                    <View style={styles.auditDot} />
                    <View style={styles.auditContent}>
                      <Text style={styles.auditAction}>
                        {log.action.charAt(0).toUpperCase() + log.action.slice(1)}
                        {log.by ? ` by ${log.by}` : ""}
                      </Text>
                      <Text style={styles.auditTime}>
                        {new Date(log.at).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </Text>
                      {!!log.note && <Text style={styles.auditNote}>{log.note}</Text>}
                    </View>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.actionRow}>
              {currentDiary.status === "draft" ? (
                canApproveDiary ? (
                  <Pressable style={styles.approveButton} onPress={handleApprove}>
                    <Ionicons name="checkmark-circle" size={20} color={Colors.white} />
                    <Text style={styles.approveButtonText}>Approve</Text>
                  </Pressable>
                ) : (
                  <View style={styles.awaitingCard}>
                    <Ionicons name="time-outline" size={16} color={Colors.warning} />
                    <Text style={styles.awaitingText}>Awaiting supervisor approval</Text>
                  </View>
                )
              ) : (
                <Pressable style={styles.revertButton} onPress={handleRevertToDraft}>
                  <Ionicons name="arrow-undo" size={18} color={Colors.warning} />
                  <Text style={styles.revertButtonText}>Revert to Draft</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        {!currentDiary && filteredEntries.length > 0 && (
          <>
            <View style={styles.rawEntriesHeader}>
              <Ionicons name="list" size={16} color={Colors.textSecondary} />
              <Text style={styles.rawEntriesLabel}>Entries in Selected Period</Text>
            </View>
            {filteredEntries.map((entry, idx) => (
              <EntryCard key={entry.id} entry={entry} index={idx} total={filteredEntries.length} />
            ))}
          </>
        )}

        {!currentDiary && filteredEntries.length === 0 && (
          <View style={styles.emptyState}>
            <Ionicons name="document-text-outline" size={48} color={Colors.textTertiary} />
            <Text style={styles.emptyTitle}>No entries in this period</Text>
            <Text style={styles.emptyText}>Switch to another report period or add new entries.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function EntryCard({ entry, index, total }: { entry: DailyEntry; index: number; total: number }) {
  const dateObj = new Date(`${entry.date}T00:00:00`);
  const formattedDate = dateObj.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <View style={styles.entryBlock}>
      <View style={styles.timelineConnector}>
        <View style={styles.timelineDot} />
        {index < total - 1 && <View style={styles.timelineLine} />}
      </View>
      <View style={styles.entryCard}>
        <Text style={styles.entryDate}>{formattedDate}</Text>
        <View style={styles.entryMetaRow}>
          {!!entry.weather && (
            <View style={styles.entryMeta}>
              <Ionicons name="partly-sunny-outline" size={13} color={Colors.accent} />
              <Text style={styles.entryMetaText}>{entry.weather}</Text>
            </View>
          )}
          {!!entry.crewCount && (
            <View style={styles.entryMeta}>
              <Ionicons name="people-outline" size={13} color={Colors.accent} />
              <Text style={styles.entryMetaText}>{entry.crewCount} crew</Text>
            </View>
          )}
        </View>
        <Text style={styles.entryNotes}>{entry.notes}</Text>
        {entry.photos.length > 0 && (
          <View style={styles.entryPhotos}>
            <Ionicons name="images-outline" size={14} color={Colors.textTertiary} />
            <Text style={styles.entryPhotosText}>{entry.photos.length} photos attached</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function SectionCard({ section, index }: { section: DiarySection; index: number }) {
  const [expanded, setExpanded] = useState(index === 0);
  const dateObj = new Date(`${section.date}T00:00:00`);
  const formattedDate = dateObj.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <View style={styles.sectionCard}>
      <Pressable style={styles.sectionHeader} onPress={() => setExpanded(!expanded)}>
        <View style={styles.sectionHeaderLeft}>
          <View style={styles.sectionDot} />
          <View>
            <Text style={styles.sectionDate}>{formattedDate}</Text>
            <View style={styles.sectionMetaRow}>
              {section.weather !== "Not recorded" && <Text style={styles.sectionMeta}>{section.weather}</Text>}
              {section.crewCount !== "Not recorded" && <Text style={styles.sectionMeta}>{section.crewCount} crew</Text>}
            </View>
          </View>
        </View>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={Colors.textTertiary} />
      </Pressable>

      {expanded && (
        <View style={styles.sectionBody}>
          <FieldBlock icon="construct" color={Colors.accent} label="Work Completed" value={section.workCompleted} />
          {section.safetyObservations !== "N/A" && (
            <FieldBlock icon="shield-checkmark" color={Colors.success} label="Safety" value={section.safetyObservations} />
          )}
          {section.materialsUsed !== "N/A" && (
            <FieldBlock icon="cube" color={Colors.warning} label="Materials" value={section.materialsUsed} />
          )}
          {section.issues !== "N/A" && (
            <FieldBlock icon="alert-circle" color={Colors.error} label="Issues" value={section.issues} />
          )}
          {shouldShowPhotoAnalysis(section.photoAnalysis) && (
            <FieldBlock icon="camera" color={Colors.primaryLight} label="Photo Analysis" value={section.photoAnalysis} />
          )}
        </View>
      )}
    </View>
  );
}

function FieldBlock({ icon, color, label, value }: { icon: keyof typeof Ionicons.glyphMap; color: string; label: string; value: string }) {
  return (
    <View style={styles.fieldBlock}>
      <View style={styles.fieldHeader}>
        <Ionicons name={icon} size={14} color={color} />
        <Text style={styles.fieldLabel}>{label}</Text>
      </View>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  notFound: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  notFoundText: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: Colors.text },
  backLink: { fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.accent },
  header: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  headerNav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerLabel: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: Colors.white },
  shareButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  scrollContent: { padding: 16, gap: 0 },
  diaryHeader: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    marginBottom: 16,
  },
  diaryBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  diaryTitle: { fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.text, textAlign: "center" },
  diarySubtitle: { fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.textSecondary, marginTop: 2 },
  diaryAddress: { fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.textTertiary, marginTop: 2, textAlign: "center" },
  diaryDateRange: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  diaryDateText: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textTertiary },
  diaryDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: Colors.textTertiary },
  galleryButton: {
    height: 50,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: 14,
    marginBottom: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  galleryButtonText: { flex: 1, fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.primary },
  generatePanel: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  periodTitle: { fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.text },
  periodRow: { flexDirection: "row", gap: 8 },
  periodChip: {
    flex: 1,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  periodChipActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  periodChipText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary },
  periodChipTextActive: { color: Colors.white },
  periodHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
  generateButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: Colors.primary,
    height: 52,
    borderRadius: 14,
  },
  generateButtonDisabled: { opacity: 0.7 },
  generateButtonText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.white },
  aiDiaryContainer: { gap: 12 },
  statusBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, marginBottom: 4 },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  statusDraft: { backgroundColor: Colors.warning + "18" },
  statusApproved: { backgroundColor: Colors.success + "18" },
  statusText: { fontSize: 11, fontFamily: "Inter_700Bold", letterSpacing: 0.5 },
  statusTextDraft: { color: Colors.warning },
  statusTextApproved: { color: Colors.success },
  generatedDate: { fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
  provenanceBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderLeftWidth: 3,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  provenanceTextWrap: { flex: 1, gap: 2 },
  provenanceLabel: { fontSize: 12, fontFamily: "Inter_700Bold", letterSpacing: 0.3 },
  provenanceDetail: { fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.textSecondary, lineHeight: 15 },
  summaryCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    borderLeftWidth: 3,
    borderLeftColor: Colors.accent,
  },
  summaryHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  summaryLabel: { fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.text, letterSpacing: 0.3 },
  summaryText: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary, lineHeight: 22 },
  checklistRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  checklistText: { flex: 1, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary, lineHeight: 20 },
  sectionCard: { backgroundColor: Colors.surface, borderRadius: 16, overflow: "hidden" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16 },
  sectionHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 12 },
  sectionDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.accent, borderWidth: 2, borderColor: Colors.accentLight + "40" },
  sectionDate: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.text },
  sectionMetaRow: { flexDirection: "row", gap: 10, marginTop: 2 },
  sectionMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
  sectionBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 14, borderTopWidth: 1, borderTopColor: Colors.borderLight, paddingTop: 14 },
  fieldBlock: { gap: 4 },
  fieldHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  fieldLabel: { fontSize: 12, fontFamily: "Inter_700Bold", color: Colors.text, letterSpacing: 0.3 },
  fieldValue: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary, lineHeight: 22, marginLeft: 20 },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  approveButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.success,
    height: 52,
    borderRadius: 14,
  },
  approveButtonText: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.white },
  revertButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.warning,
  },
  revertButtonText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.warning },
  awaitingCard: {
    flex: 1,
    height: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.warning,
    backgroundColor: Colors.warning + "14",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  awaitingText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.warning,
  },
  editChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginLeft: "auto",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: Colors.accent + "14",
  },
  editChipText: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: Colors.accent },
  editTextArea: {
    backgroundColor: Colors.background,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.accent + "60",
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    lineHeight: 22,
    minHeight: 80,
  },
  editTextAreaLarge: { minHeight: 160 },
  editActions: { flexDirection: "row", gap: 8, marginTop: 8, justifyContent: "flex-end" },
  editCancelBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  editCancelText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary },
  editSaveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.accent,
  },
  editSaveText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.white },
  auditRow: { flexDirection: "row", gap: 10, alignItems: "flex-start", marginTop: 8 },
  auditDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.textTertiary, marginTop: 5 },
  auditContent: { flex: 1, gap: 1 },
  auditAction: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.text },
  auditTime: { fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
  auditNote: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary, fontStyle: "italic", marginTop: 2 },
  rawEntriesHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12, marginTop: 4 },
  rawEntriesLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary },
  emptyState: { alignItems: "center", paddingTop: 40, gap: 10 },
  emptyTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: Colors.text },
  emptyText: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary, textAlign: "center" },
  entryBlock: { flexDirection: "row", gap: 14, marginBottom: 8 },
  timelineConnector: { width: 20, alignItems: "center", paddingTop: 6 },
  timelineDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.accent, borderWidth: 2, borderColor: Colors.accentLight + "40" },
  timelineLine: { flex: 1, width: 2, backgroundColor: Colors.border, marginTop: 4 },
  entryCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: 16, padding: 16, gap: 8 },
  entryDate: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.text },
  entryMetaRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  entryMeta: { flexDirection: "row", alignItems: "center", gap: 4 },
  entryMetaText: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.accent },
  entryNotes: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary, lineHeight: 22 },
  entryPhotos: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  entryPhotosText: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
});
