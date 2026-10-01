import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet, Alert, ActivityIndicator,
  TextInput, Modal, Platform,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Colors from "@/constants/colors";
import { formatDate } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import { runReportExport, buildHtmlDocument } from "@/lib/export-utils";
import { reportMediaFailure } from "@/lib/media-telemetry";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { ScreenHeader } from "@/components/ScreenHeader";

type Timecard = {
  id: string; workerName: string; date: string;
  startTime?: string; endTime?: string; breakMinutes?: number;
  hoursRegular: number; hoursOvertime: number; trade: string; notes: string;
};

function calcHours(start: string, end: string, breakMin: number) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const totalMin = (eh * 60 + em) - (sh * 60 + sm) - (breakMin || 0);
  const total = Math.max(0, totalMin / 60);
  const regular = Math.min(total, 8);
  const overtime = Math.max(0, total - 8);
  return { regular: parseFloat(regular.toFixed(2)), overtime: parseFloat(overtime.toFixed(2)) };
}

function formatTime(t: string) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${period}`;
}

function groupByWeek(timecards: Timecard[]) {
  const weeks: Record<string, Timecard[]> = {};
  timecards.forEach((tc) => {
    const d = new Date(tc.date + "T00:00:00");
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!weeks[key]) weeks[key] = [];
    weeks[key].push(tc);
  });
  return Object.entries(weeks).sort((a, b) => b[0].localeCompare(a[0]));
}

function weekLabel(weekStart: string) {
  const start = new Date(weekStart + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  return `${fmt(start)} – ${fmt(end)}`;
}

async function getToken() { return AsyncStorage.getItem("sitesnap.token"); }

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const base = getApiBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

// Conversions between the stored "HH:MM" / "YYYY-MM-DD" strings and the Date
// objects the native picker works with.
function hhmmToDate(t: string): Date {
  const [h, m] = (t || "").split(":").map(Number);
  const d = new Date();
  d.setHours(Number.isFinite(h) ? h : 7, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}
function dateToHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function ymdToDate(s: string): Date {
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d.getTime()) ? new Date() : d;
}
function dateToYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildTimecardHtml(timecards: Timecard[], siteName: string) {
  const totalReg = timecards.reduce((s, t) => s + t.hoursRegular, 0);
  const totalOT  = timecards.reduce((s, t) => s + t.hoursOvertime, 0);
  const rows = timecards.map((tc) => `
    <tr>
      <td>${formatDate(tc.date)}</td>
      <td>${tc.workerName}</td>
      <td>${formatTime(tc.startTime || "")}</td>
      <td>${formatTime(tc.endTime || "")}</td>
      <td>${tc.breakMinutes ?? 0} min</td>
      <td>${tc.hoursRegular.toFixed(2)}h</td>
      <td style="color:#E8731A;font-weight:700">${tc.hoursOvertime > 0 ? tc.hoursOvertime.toFixed(2) + "h" : "—"}</td>
      <td>${tc.notes || "—"}</td>
    </tr>
  `).join("");

  return buildHtmlDocument({
    eyebrow: "Timesheet Export",
    title: siteName,
    subtitle: `Generated ${new Date().toLocaleString("en-AU")} · ${timecards.length} records`,
    meta: [
      { label: "Records", value: String(timecards.length) },
      { label: "Regular Hours", value: `${totalReg.toFixed(1)}h` },
      { label: "Overtime Hours", value: `${totalOT.toFixed(1)}h` },
      { label: "Total Hours", value: `${(totalReg + totalOT).toFixed(1)}h` },
    ],
    body: `
      <table class="data-table">
        <thead><tr><th>Date</th><th>Worker</th><th>Start</th><th>End</th><th>Break</th><th>Regular</th><th>OT</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  });
}

export default function CrewTimecards() {
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const { getSite } = useData();
  const { user } = useAuth();
  const site = getSite(siteId);
  const insets = useSafeAreaInsets();

  const [timecards, setTimecards] = useState<Timecard[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [saving, setSaving]       = useState(false);
  const [exporting, setExporting] = useState(false);
  const [tab, setTab]             = useState<"list" | "summary">("list");

  // Form state — worker defaults to the logged-in user; site comes from the
  // screen context (no picker). start/finish/break default to this site's last
  // used values (see openForm).
  const [workerName, setWorkerName]     = useState(user?.name ?? "");
  const [date, setDate]                 = useState(new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime]       = useState("07:00");
  const [endTime, setEndTime]           = useState("15:30");
  const [breakMinutes, setBreakMinutes] = useState("30");
  const [notes, setNotes]               = useState("");
  const [showMore, setShowMore]         = useState(false);
  const [picker, setPicker]             = useState<null | "date" | "start" | "end">(null);

  const computed = useMemo(() => {
    if (startTime && endTime) return calcHours(startTime, endTime, Number(breakMinutes) || 0);
    return { regular: 0, overtime: 0 };
  }, [startTime, endTime, breakMinutes]);

  const weeks = useMemo(() => groupByWeek(timecards), [timecards]);

  const totals = useMemo(() => ({
    workers: new Set(timecards.map((t) => t.workerName)).size,
    regular: timecards.reduce((s, t) => s + t.hoursRegular, 0),
    overtime: timecards.reduce((s, t) => s + t.hoursOvertime, 0),
  }), [timecards]);

  const load = async () => {
    try {
      const data = await apiJson<{ timecards: Timecard[] }>(`/api/crew/timecards?siteId=${siteId}`);
      setTimecards(data.timecards);
    } catch (err) { console.warn(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [siteId]);

  const resetForm = () => {
    setWorkerName(user?.name ?? "");
    setNotes("");
    setShowMore(false);
    setPicker(null);
    setDate(new Date().toISOString().slice(0, 10));
    setStartTime("07:00"); setEndTime("15:30"); setBreakMinutes("30");
  };

  const openForm = () => {
    resetForm();
    // Default start/finish/break to this site's most recent timecard — most
    // crews work similar hours, so remembering beats a fixed guess.
    const last = [...timecards].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (last) {
      if (last.startTime) setStartTime(last.startTime);
      if (last.endTime) setEndTime(last.endTime);
      if (typeof last.breakMinutes === "number") setBreakMinutes(String(last.breakMinutes));
    }
    setShowForm(true);
  };

  const handleAdd = async () => {
    if (!workerName.trim()) { Alert.alert("Required", "Worker name is required."); return; }
    setSaving(true);
    try {
      await apiJson(`/api/crew/timecards`, {
        method: "POST",
        body: JSON.stringify({
          siteId, workerName: workerName.trim(), trade: "", date,
          startTime, endTime, breakMinutes: Number(breakMinutes) || 0,
          hoursRegular: computed.regular,
          hoursOvertime: computed.overtime,
          notes,
        }),
      });
      resetForm();
      setShowForm(false);
      await load();
    } catch { Alert.alert("Error", "Failed to save timecard."); }
    finally { setSaving(false); }
  };

  const handleDelete = (id: string) => {
    Alert.alert("Delete Record", "Remove this timecard entry?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          await apiJson(`/api/crew/timecards/${id}`, { method: "DELETE" }).catch(() => {});
          setTimecards((prev) => prev.filter((t) => t.id !== id));
        },
      },
    ]);
  };

  const handleExport = async () => {
    if (timecards.length === 0) { Alert.alert("No Data", "Add timecards before exporting."); return; }
    setExporting(true);
    try {
      const html = buildTimecardHtml(timecards, site?.name ?? "Site");
      await runReportExport({
        filenameBase: `timecards-${site?.name?.toLowerCase().replace(/\s+/g, "-") ?? siteId}-${new Date().toISOString().slice(0, 10)}`,
        html,
        format: "pdf",
        label: "the timesheet",
      });
    } catch (error) {
      // runReportExport does not reject, so this is buildTimecardHtml failing.
      Alert.alert("Export Failed", "Could not export the timesheet.");
      reportMediaFailure({ kind: "export-failed", label: "the timesheet (document build)", format: "pdf", cause: error });
    }
    finally { setExporting(false); }
  };

  return (
    <View style={styles.container}>
      <ScreenHeader
        borderWidth={1}
        variant="light"
        title="Timesheets"
        subtitle={site?.name}
        paddingBottom={12}
        paddingTopExtra={12}
        gap={10}
        backButtonStyle={styles.backBtn}
        titleStyle={styles.headerTitle}
        subtitleStyle={styles.headerSub}
        right={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Pressable onPress={handleExport} style={styles.exportBtn} disabled={exporting}>
              {exporting
                ? <ActivityIndicator size="small" color={Colors.accent} />
                : <Ionicons name="share-outline" size={20} color={Colors.accent} />
              }
            </Pressable>
            <Pressable onPress={openForm} style={styles.addBtn}>
              <Ionicons name="add" size={22} color={Colors.white} />
            </Pressable>
          </View>
        }
      />

      {/* Summary banner */}
      {timecards.length > 0 && (
        <View style={styles.summaryBanner}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>{totals.workers}</Text>
            <Text style={styles.summaryLab}>Workers</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>{totals.regular.toFixed(1)}h</Text>
            <Text style={styles.summaryLab}>Regular</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={[styles.summaryVal, totals.overtime > 0 && { color: Colors.accent }]}>{totals.overtime.toFixed(1)}h</Text>
            <Text style={styles.summaryLab}>Overtime</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryVal}>{(totals.regular + totals.overtime).toFixed(1)}h</Text>
            <Text style={styles.summaryLab}>Total</Text>
          </View>
        </View>
      )}

      {/* Tabs */}
      {timecards.length > 0 && (
        <View style={styles.tabs}>
          {(["list", "summary"] as const).map((t) => (
            <Pressable key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === "list" ? "By Week" : "By Worker"}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {loading
        ? <ActivityIndicator style={{ marginTop: 48 }} color={Colors.primary} />
        : timecards.length === 0
          ? <EmptyState icon="time-outline" title="No timecards yet" subtitle="Log crew hours with start & end times, breaks, and overtime." ctaLabel="Add Timecard" onCta={openForm} />
          : tab === "list"
            ? (
              <ScrollView contentContainerStyle={styles.listContent}>
                {weeks.map(([weekStart, cards]) => {
                  const wReg = cards.reduce((s, c) => s + c.hoursRegular, 0);
                  const wOT  = cards.reduce((s, c) => s + c.hoursOvertime, 0);
                  return (
                    <View key={weekStart}>
                      <View style={styles.weekHeader}>
                        <Text style={styles.weekLabel}>Week of {weekLabel(weekStart)}</Text>
                        <Text style={styles.weekTotals}>{wReg.toFixed(1)}h reg · <Text style={{ color: Colors.accent }}>{wOT.toFixed(1)}h OT</Text></Text>
                      </View>
                      {cards.map((tc) => (
                        <View key={tc.id} style={styles.card}>
                          <View style={styles.cardDateCol}>
                            <Text style={styles.cardDayName}>{new Date(tc.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short" })}</Text>
                            <Text style={styles.cardDayNum}>{new Date(tc.date + "T00:00:00").getDate()}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={styles.cardTopRow}>
                              <Text style={styles.cardName}>{tc.workerName}</Text>
                            </View>
                            <View style={styles.cardTimeRow}>
                              <Ionicons name="time-outline" size={13} color={Colors.textTertiary} />
                              <Text style={styles.cardTimeTxt}>
                                {tc.startTime ? formatTime(tc.startTime) : "—"} – {tc.endTime ? formatTime(tc.endTime) : "—"}
                                {tc.breakMinutes ? `  ·  ${tc.breakMinutes}min break` : ""}
                              </Text>
                            </View>
                            <View style={styles.cardHoursRow}>
                              <View style={styles.hoursChip}>
                                <Text style={styles.hoursChipText}>{tc.hoursRegular.toFixed(1)}h reg</Text>
                              </View>
                              {tc.hoursOvertime > 0 && (
                                <View style={[styles.hoursChip, styles.hoursChipOT]}>
                                  <Text style={[styles.hoursChipText, { color: Colors.accent }]}>{tc.hoursOvertime.toFixed(1)}h OT</Text>
                                </View>
                              )}
                            </View>
                            {!!tc.notes && <Text style={styles.cardNotes} numberOfLines={1}>{tc.notes}</Text>}
                          </View>
                          <Pressable onPress={() => handleDelete(tc.id)} hitSlop={10} style={styles.deleteBtn}>
                            <Ionicons name="trash-outline" size={17} color={Colors.error} />
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  );
                })}
              </ScrollView>
            )
            : (
              // By Worker summary
              <ScrollView contentContainerStyle={styles.listContent}>
                {Array.from(new Set(timecards.map((t) => t.workerName))).sort().map((worker) => {
                  const wCards = timecards.filter((t) => t.workerName === worker);
                  const wReg  = wCards.reduce((s, c) => s + c.hoursRegular, 0);
                  const wOT   = wCards.reduce((s, c) => s + c.hoursOvertime, 0);
                  const trades = [...new Set(wCards.map((c) => c.trade).filter(Boolean))];
                  return (
                    <View key={worker} style={styles.workerCard}>
                      <View style={styles.workerAvatar}>
                        <Text style={styles.workerAvatarText}>{worker.charAt(0).toUpperCase()}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.workerName}>{worker}</Text>
                        {trades.length > 0 && <Text style={styles.workerTrade}>{trades.join(", ")}</Text>}
                        <View style={styles.workerStats}>
                          <Text style={styles.workerStatItem}>{wCards.length} days</Text>
                          <Text style={styles.workerStatDot}>·</Text>
                          <Text style={styles.workerStatItem}>{wReg.toFixed(1)}h regular</Text>
                          {wOT > 0 && <>
                            <Text style={styles.workerStatDot}>·</Text>
                            <Text style={[styles.workerStatItem, { color: Colors.accent }]}>{wOT.toFixed(1)}h OT</Text>
                          </>}
                        </View>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={styles.workerTotal}>{(wReg + wOT).toFixed(1)}h</Text>
                        <Text style={styles.workerTotalLab}>total</Text>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            )
      }

      {/* Add Timecard Modal */}
      <Modal visible={showForm} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { paddingTop: insets.top + 16 }]}>
          <View style={styles.modalHeader}>
            <Pressable onPress={() => { setShowForm(false); resetForm(); }} style={styles.modalClose}>
              <Ionicons name="close" size={24} color={Colors.text} />
            </Pressable>
            <Text style={styles.modalTitle}>Add Timecard</Text>
            <Pressable onPress={handleAdd} disabled={saving} style={[styles.modalSaveBtn, saving && { opacity: 0.6 }]}>
              {saving ? <ActivityIndicator size="small" color={Colors.white} /> : <Text style={styles.modalSaveTxt}>Save</Text>}
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
            {/* Date */}
            <Text style={styles.formSectionLabel}>Date</Text>
            <View style={styles.formCard}>
              <Pressable style={styles.pickRow} onPress={() => setPicker("date")}>
                <Ionicons name="calendar-outline" size={18} color={Colors.textTertiary} />
                <Text style={styles.pickValue}>{formatDate(date)}</Text>
                <Ionicons name="chevron-down" size={16} color={Colors.textTertiary} />
              </Pressable>
            </View>

            {/* Hours — start / finish / break */}
            <Text style={styles.formSectionLabel}>Hours</Text>
            <View style={styles.formCard}>
              <View style={styles.timeRow}>
                <Pressable style={styles.timeBox} onPress={() => setPicker("start")}>
                  <Text style={styles.inputLabel}>Start</Text>
                  <Text style={styles.timeValue}>{formatTime(startTime)}</Text>
                </Pressable>
                <View style={styles.timeSep}><Text style={{ color: Colors.textTertiary, fontSize: 20 }}>→</Text></View>
                <Pressable style={styles.timeBox} onPress={() => setPicker("end")}>
                  <Text style={styles.inputLabel}>Finish</Text>
                  <Text style={styles.timeValue}>{formatTime(endTime)}</Text>
                </Pressable>
              </View>
              <View style={[styles.breakBlock, { borderTopWidth: 1, borderTopColor: Colors.borderLight }]}>
                <Text style={styles.inputLabel}>Break</Text>
                <View style={styles.breakChips}>
                  {["0", "15", "30", "45", "60", "90"].map((m) => (
                    <Pressable key={m} onPress={() => setBreakMinutes(m)} style={[styles.breakChip, breakMinutes === m && styles.breakChipActive]}>
                      <Text style={[styles.breakChipTxt, breakMinutes === m && styles.breakChipTxtActive]}>{m === "0" ? "None" : `${m}m`}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Computed result */}
              {(computed.regular > 0 || computed.overtime > 0) && (
                <View style={styles.computedRow}>
                  <View style={styles.computedChip}>
                    <Ionicons name="checkmark-circle" size={14} color={Colors.success} />
                    <Text style={styles.computedTxt}>{computed.regular.toFixed(2)}h regular</Text>
                  </View>
                  {computed.overtime > 0 && (
                    <View style={[styles.computedChip, { backgroundColor: Colors.accent + "18" }]}>
                      <Ionicons name="alert-circle" size={14} color={Colors.accent} />
                      <Text style={[styles.computedTxt, { color: Colors.accent }]}>{computed.overtime.toFixed(2)}h overtime</Text>
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* More — worker override (for logging someone else) + notes */}
            <Pressable style={styles.moreToggle} onPress={() => setShowMore((v) => !v)}>
              <Text style={styles.moreToggleTxt}>{showMore ? "Hide extra details" : "Logging for someone else, or add a note?"}</Text>
              <Ionicons name={showMore ? "chevron-up" : "chevron-down"} size={16} color={Colors.accent} />
            </Pressable>
            {showMore && (
              <View style={styles.formCard}>
                <View style={styles.formRow}>
                  <Ionicons name="person-outline" size={18} color={Colors.textTertiary} style={{ marginTop: 14 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>Worker Name</Text>
                    <TextInput style={styles.input} placeholder="Full name" value={workerName} onChangeText={setWorkerName} placeholderTextColor={Colors.textTertiary} />
                  </View>
                </View>
                <View style={[styles.formRow, { borderTopWidth: 1, borderTopColor: Colors.borderLight }]}>
                  <Ionicons name="document-text-outline" size={18} color={Colors.textTertiary} style={{ marginTop: 14 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.inputLabel}>Notes</Text>
                    <TextInput style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} placeholder="Optional (work area, cost code…)" value={notes} onChangeText={setNotes} multiline placeholderTextColor={Colors.textTertiary} />
                  </View>
                </View>
              </View>
            )}

            {/* Native date/time pickers */}
            {picker && Platform.OS === "ios" && (
              <View style={styles.iosPicker}>
                <Pressable style={styles.iosPickerDone} onPress={() => setPicker(null)}>
                  <Text style={styles.iosPickerDoneTxt}>Done</Text>
                </Pressable>
                <DateTimePicker
                  value={picker === "date" ? ymdToDate(date) : picker === "start" ? hhmmToDate(startTime) : hhmmToDate(endTime)}
                  mode={picker === "date" ? "date" : "time"}
                  display="spinner"
                  // UIDatePicker is rendered by iOS, not by us, so with no
                  // themeVariant it follows the SYSTEM appearance while the card
                  // behind it is always Colors.surface (#FFFFFF). In dark
                  // appearance that drew white wheel text on white, leaving only
                  // the selection band visible — the whole "empty picker" bug.
                  // `Colors` has no dark palette, so the picker is pinned light
                  // to match it. See docs/DECISIONS.md ADR-0002.
                  themeVariant="light"
                  textColor={Colors.text}
                  style={styles.iosPickerWheel}
                  onChange={(_e: DateTimePickerEvent, d?: Date) => {
                    if (!d) return;
                    if (picker === "date") setDate(dateToYMD(d));
                    else if (picker === "start") setStartTime(dateToHHMM(d));
                    else setEndTime(dateToHHMM(d));
                  }}
                />
              </View>
            )}
            {picker && Platform.OS !== "ios" && (
              <DateTimePicker
                value={picker === "date" ? ymdToDate(date) : picker === "start" ? hhmmToDate(startTime) : hhmmToDate(endTime)}
                mode={picker === "date" ? "date" : "time"}
                onChange={(e: DateTimePickerEvent, d?: Date) => {
                  setPicker(null);
                  if (e.type === "set" && d) {
                    if (picker === "date") setDate(dateToYMD(d));
                    else if (picker === "start") setStartTime(dateToHHMM(d));
                    else setEndTime(dateToHHMM(d));
                  }
                }}
              />
            )}
          </ScrollView>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  // Header
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 17, fontFamily: "Inter_700Bold", fontWeight: undefined, color: Colors.text },
  headerSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary, marginTop: 0 },
  exportBtn: { padding: 8, borderWidth: 1, borderColor: Colors.accent + "44", borderRadius: 10, marginLeft: "auto" },
  addBtn: { backgroundColor: Colors.primary, borderRadius: 10, padding: 8 },

  // Summary banner
  summaryBanner: { flexDirection: "row", backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border, paddingVertical: 12 },
  summaryItem: { flex: 1, alignItems: "center" },
  summaryVal: { fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.primary },
  summaryLab: { fontSize: 10, fontFamily: "Inter_500Medium", color: Colors.textTertiary, marginTop: 2, textTransform: "uppercase", letterSpacing: 0.4 },
  summaryDivider: { width: 1, backgroundColor: Colors.border, marginVertical: 4 },

  // Tabs
  tabs: { flexDirection: "row", backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border, paddingHorizontal: 16, gap: 4 },
  tab: { paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: Colors.accent },
  tabText: { fontSize: 14, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  tabTextActive: { color: Colors.accent, fontFamily: "Inter_600SemiBold" },

  listContent: { padding: 16, gap: 8, paddingBottom: 40 },

  // Week header
  weekHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8, paddingHorizontal: 4, marginTop: 8, marginBottom: 4 },
  weekLabel: { fontSize: 13, fontFamily: "Inter_700Bold", color: Colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.4 },
  weekTotals: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textSecondary },

  // Timecard card
  card: { backgroundColor: Colors.surface, borderRadius: 16, padding: 14, flexDirection: "row", alignItems: "flex-start", gap: 12, borderWidth: 1, borderColor: Colors.border },
  cardDateCol: { width: 42, alignItems: "center", paddingTop: 2 },
  cardDayName: { fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.textTertiary, textTransform: "uppercase" },
  cardDayNum: { fontSize: 22, fontFamily: "Inter_700Bold", color: Colors.primary },
  cardTopRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  cardName: { fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.text, flex: 1 },
  cardTimeRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 6 },
  cardTimeTxt: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  cardHoursRow: { flexDirection: "row", gap: 6 },
  hoursChip: { backgroundColor: Colors.success + "18", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  hoursChipOT: { backgroundColor: Colors.accent + "18" },
  hoursChipText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.success },
  cardNotes: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textTertiary, marginTop: 6 },
  deleteBtn: { padding: 6, marginTop: 2 },

  // Worker summary
  workerCard: { backgroundColor: Colors.surface, borderRadius: 16, padding: 16, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1, borderColor: Colors.border },
  workerAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  workerAvatarText: { fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.white },
  workerName: { fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.text },
  workerTrade: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary, marginTop: 1 },
  workerStats: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  workerStatItem: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  workerStatDot: { fontSize: 12, color: Colors.textTertiary },
  workerTotal: { fontSize: 20, fontFamily: "Inter_700Bold", color: Colors.primary },
  workerTotalLab: { fontSize: 10, fontFamily: "Inter_500Medium", color: Colors.textTertiary, textAlign: "right" },

  // Modal
  modal: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: Colors.border, gap: 12 },
  modalClose: { padding: 4 },
  modalTitle: { flex: 1, fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.text },
  modalSaveBtn: { backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 8 },
  modalSaveTxt: { color: Colors.white, fontFamily: "Inter_600SemiBold", fontSize: 14 },
  modalContent: { padding: 16, gap: 8, paddingBottom: 40 },

  formSectionLabel: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8, marginLeft: 4 },
  formCard: { backgroundColor: Colors.surface, borderRadius: 16, paddingHorizontal: 16, borderWidth: 1, borderColor: Colors.border },
  formRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 10 },
  inputLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textSecondary, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 12, fontSize: 15, color: Colors.text, backgroundColor: Colors.surface },
  timeRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 14 },
  timeSep: { alignItems: "center", paddingTop: 24 },
  computedRow: { flexDirection: "row", gap: 8, paddingBottom: 12, paddingTop: 4 },
  computedChip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: Colors.success + "18", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  computedTxt: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.success },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 16 },
  pickValue: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.text },
  timeBox: { flex: 1, paddingVertical: 14, paddingHorizontal: 14, alignItems: "center" },
  timeValue: { fontSize: 20, fontFamily: "Inter_600SemiBold", color: Colors.text, marginTop: 4 },
  breakBlock: { paddingHorizontal: 14, paddingVertical: 14 },
  breakChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  breakChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface },
  breakChipActive: { backgroundColor: Colors.accent + "18", borderColor: Colors.accent },
  breakChipTxt: { fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  breakChipTxtActive: { color: Colors.accent, fontFamily: "Inter_600SemiBold" },
  moreToggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4, paddingVertical: 12 },
  moreToggleTxt: { fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.accent },
  iosPicker: { backgroundColor: Colors.surface, borderRadius: 14, marginTop: 8 },
  // An explicit height, matching new-entry.tsx and create-site.tsx. Without one
  // the spinner reports an intrinsic height that leaves a large empty band.
  iosPickerWheel: { backgroundColor: Colors.surface, height: 180 },
  iosPickerDone: { alignItems: "flex-end", paddingHorizontal: 16, paddingTop: 10 },
  iosPickerDoneTxt: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.accent },

  // Trade picker
});
