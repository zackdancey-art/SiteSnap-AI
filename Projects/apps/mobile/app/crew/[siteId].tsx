import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet, Alert, ActivityIndicator,
  TextInput, Modal, Platform,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import Colors from "@/constants/colors";
import { formatDate } from "@/lib/format";
import { EmptyState } from "@/components/EmptyState";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import { runReportExport, buildHtmlDocument, escapeHtml } from "@/lib/export-utils";
import { reportMediaFailure } from "@/lib/media-telemetry";
import { authedJson as apiJson } from "@/lib/authed-fetch";
import { isSessionExpired } from "@/lib/session";
import { ScreenHeader } from "@/components/ScreenHeader";
import {
  canApproveTimesheet,
  describeFailure,
  isTimecardEditable,
  isTimecardLocked,
  normaliseApprovalStatus,
  TIMECARD_LOCKED_MESSAGE,
  type TimecardApprovalStatus,
} from "@/lib/permissions";

type Timecard = {
  id: string; workerName: string; date: string;
  startTime?: string; endTime?: string; breakMinutes?: number;
  hoursRegular: number; hoursOvertime: number; trade: string; notes: string;
  // Typed as it arrives on the wire — a string this build may not recognise —
  // and never read directly. statusOf() is the only reader.
  approvalStatus?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalNote?: string | null;
};

/**
 * The card's status, always through the normaliser — the field arrives as
 * whatever string the API sent and is never read raw. The model itself
 * (the status list, which states are editable, and which way an unrecognised
 * one falls) lives in lib/permissions.ts, because this file imports
 * react-native and so nothing here can be unit-tested.
 */
function statusOf(tc: Timecard): TimecardApprovalStatus {
  return normaliseApprovalStatus(tc.approvalStatus);
}

/**
 * How each state looks and what it is called.
 *
 * "Sent back" rather than "Rejected": the API's word is `rejected`, but the
 * person reading this is the worker whose hours they are, and "rejected" reads
 * as a judgement of them rather than of a form that needs a correction. Same
 * state, honest word.
 *
 * `approved` takes a padlock rather than a tick, because the useful fact about
 * an approved card is not that somebody agreed with it — it is that it can no
 * longer be changed.
 */
const STATUS_STYLE: Record<
  TimecardApprovalStatus,
  { label: string; icon: keyof typeof Ionicons.glyphMap; bg: string; border: string; text: string }
> = {
  pending: {
    label: "Pending", icon: "time-outline",
    bg: Colors.warningBg, border: Colors.warningBorder, text: Colors.warningText,
  },
  approved: {
    label: "Approved", icon: "lock-closed-outline",
    bg: Colors.successBg, border: Colors.successBorder, text: Colors.successText,
  },
  rejected: {
    label: "Sent back", icon: "arrow-undo-outline",
    bg: Colors.errorBg, border: Colors.errorBorder, text: Colors.errorText,
  },
};

/**
 * What each approval transition is called, asked, and blamed for.
 *
 * Keyed by the status being moved TO, so a status added to the mirrored list
 * without wording here is a type error rather than an Alert with no words in
 * it. The prompts say what the transition costs — approving locks the card,
 * reopening clears who approved it — because both are consequences a manager
 * tapping a small button on a phone should be told about before, not after.
 */
const APPROVAL_ACTION: Record<
  TimecardApprovalStatus,
  { title: string; prompt: (worker: string) => string; confirm: string; failure: string }
> = {
  approved: {
    title: "Approve timecard",
    prompt: (worker) =>
      `Approve ${worker}'s hours? The card is locked once approved — if it needs changing, reopen it first.`,
    confirm: "Approve",
    failure: "Could not approve the timecard.",
  },
  rejected: {
    title: "Send back",
    prompt: (worker) =>
      `Send ${worker}'s timecard back for correction? They will be able to edit it again. The reason has to be added in the portal — this screen cannot attach one.`,
    confirm: "Send back",
    failure: "Could not send the timecard back.",
  },
  pending: {
    title: "Reopen timecard",
    prompt: (worker) =>
      `Reopen ${worker}'s timecard for editing? This clears the record of who approved it and when.`,
    confirm: "Reopen",
    failure: "Could not reopen the timecard.",
  },
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

const CLOCK_TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/** Minutes since midnight, or null if the value is not a usable clock time. */
function parseClockMinutes(value: string): number | null {
  if (!CLOCK_TIME_PATTERN.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// The client half of the span validation. The API's TimecardSchema.superRefine
// (services/api/src/routes/crew.ts) is authoritative and rejects all of this
// with a 400; this mirrors it so the person entering the card sees the problem
// on the field instead of a generic failure Alert after a round trip.
//
// Keep the two in step. If they drift, the server wins and the symptom is a
// save that looks fine here and fails there.
function timecardSpanProblem(start: string, finish: string, breakMin: number): string | null {
  const s = start.trim();
  const f = finish.trim();
  if (!s && !f) return null;
  if (!s) return "Add a start time, or clear the finish time.";
  if (!f) return "Add a finish time, or clear the start time.";

  const sMin = parseClockMinutes(s);
  const fMin = parseClockMinutes(f);
  if (sMin === null) return "Start time must be a time of day in HH:MM form, e.g. 07:00.";
  if (fMin === null) return "Finish time must be a time of day in HH:MM form, e.g. 15:30.";

  if (fMin <= sMin) {
    return `Finish time ${formatTime(f)} is not after the start time ${formatTime(s)}. Overnight shifts are not supported.`;
  }
  if (fMin - sMin - (breakMin || 0) <= 0) {
    return `A ${breakMin} minute break leaves no worked time between ${formatTime(s)} and ${formatTime(f)}.`;
  }
  return null;
}

// The default pair is 07:00 -> 15:30, so a finish derived from a start keeps
// that 8h30 shape. Used when a chosen start overtakes the finish: shifting the
// finish is what the person meant, and it beats leaving an invalid pair on
// screen for them to notice.
const DEFAULT_SHIFT_MINUTES = 8 * 60 + 30;
function deriveFinishFrom(start: string): string {
  const sMin = parseClockMinutes(start);
  if (sMin === null) return "15:30";
  const fMin = Math.min(sMin + DEFAULT_SHIFT_MINUTES, 23 * 60 + 59);
  return `${String(Math.floor(fMin / 60)).padStart(2, "0")}:${String(fMin % 60).padStart(2, "0")}`;
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
  const approvedCount = timecards.filter((t) => statusOf(t) === "approved").length;
  // Every interpolated cell goes through escapeHtml. The helper has been
  // exported from lib/export-utils since that module was written and every
  // other builder in it uses it; this table was the one that did not, so a
  // worker name or a note containing a `<` broke the document. Fixed here
  // rather than left as the one unescaped table, now that an approval note —
  // text a manager types — is going into it too.
  const rows = timecards.map((tc) => {
    const status = statusOf(tc);
    const by = tc.approvedBy ? ` (${tc.approvedBy})` : "";
    return `
    <tr>
      <td>${escapeHtml(formatDate(tc.date))}</td>
      <td>${escapeHtml(tc.workerName)}</td>
      <td>${escapeHtml(formatTime(tc.startTime || ""))}</td>
      <td>${escapeHtml(formatTime(tc.endTime || ""))}</td>
      <td>${escapeHtml(`${tc.breakMinutes ?? 0} min`)}</td>
      <td>${escapeHtml(`${tc.hoursRegular.toFixed(2)}h`)}</td>
      <td style="color:#E8731A;font-weight:700">${escapeHtml(tc.hoursOvertime > 0 ? tc.hoursOvertime.toFixed(2) + "h" : "—")}</td>
      <td>${escapeHtml(STATUS_STYLE[status].label + by)}</td>
      <td>${escapeHtml(tc.notes || "—")}</td>
    </tr>
  `;
  }).join("");

  return buildHtmlDocument({
    eyebrow: "Timesheet Export",
    title: siteName,
    subtitle: `Generated ${new Date().toLocaleString("en-AU")} · ${timecards.length} records`,
    meta: [
      { label: "Records", value: String(timecards.length) },
      // An export of a payroll week has to say how much of it is actually
      // approved. Without this the document reads as a settled record when
      // most of it may still be pending.
      { label: "Approved", value: `${approvedCount} of ${timecards.length}` },
      { label: "Regular Hours", value: `${totalReg.toFixed(1)}h` },
      { label: "Overtime Hours", value: `${totalOT.toFixed(1)}h` },
      { label: "Total Hours", value: `${(totalReg + totalOT).toFixed(1)}h` },
    ],
    body: `
      <table class="data-table">
        <thead><tr><th>Date</th><th>Worker</th><th>Start</th><th>End</th><th>Break</th><th>Regular</th><th>OT</th><th>Approval</th><th>Notes</th></tr></thead>
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

  // Manager+, decided in lib/permissions.ts. This hides one control on
  // somebody else's card and is NOT permission to use timesheets, which crew
  // keep in full. requireAtLeast("manager") on POST /crew/timecards/:id/approval
  // is the enforcement — a hidden button is still a reachable route.
  const mayApprove = canApproveTimesheet(user?.companyRole);

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

  // The whole record, not just its id: deciding whether an edit may be opened
  // needs the card's status, and holding the row means that decision is made
  // against the card that was tapped rather than against a lookup that could
  // miss after a reload.
  const [editing, setEditing]           = useState<Timecard | null>(null);
  const [approvingId, setApprovingId]   = useState<string | null>(null);

  // Whether the person has touched start, finish or break since the form
  // opened. An edit sends the span only when it is theirs to send — see
  // handleSave, where sending an untouched default would invent a shift on a
  // card that never had one.
  const [spanTouched, setSpanTouched]   = useState(false);

  const computed = useMemo(() => {
    if (startTime && endTime) return calcHours(startTime, endTime, Number(breakMinutes) || 0);
    return { regular: 0, overtime: 0 };
  }, [startTime, endTime, breakMinutes]);

  const spanProblem = useMemo(
    () => timecardSpanProblem(startTime, endTime, Number(breakMinutes) || 0),
    [startTime, endTime, breakMinutes]
  );

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
    setEditing(null);
    setSpanTouched(false);
  };

  const openForm = () => {
    resetForm();
    // Default start/finish/break to this site's most recent timecard — most
    // crews work similar hours, so remembering beats a fixed guess.
    const last = [...timecards].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (last) {
      // Decline a prefill that would not save. Rows predating the span
      // validation can hold a finish before its start (that is the defect this
      // item is about), and copying one forward would open the form already
      // invalid, blaming the new card for the old one's data.
      const lastBreak = typeof last.breakMinutes === "number" ? last.breakMinutes : 0;
      const prefillable =
        last.startTime &&
        last.endTime &&
        timecardSpanProblem(last.startTime, last.endTime, lastBreak) === null;
      if (prefillable) {
        setStartTime(last.startTime!);
        setEndTime(last.endTime!);
        setBreakMinutes(String(lastBreak));
      }
    }
    setShowForm(true);
  };

  // Choosing a start that overtakes the finish derives a new finish rather than
  // leaving the pair invalid. An explicit finish the user has already set past
  // the new start is left exactly as they set it.
  const applyStartTime = (next: string) => {
    setSpanTouched(true);
    setStartTime(next);
    const nextMin = parseClockMinutes(next);
    const endMin = parseClockMinutes(endTime);
    if (nextMin !== null && (endMin === null || endMin <= nextMin)) {
      setEndTime(deriveFinishFrom(next));
    }
  };

  // The finish time and the break go through these for one reason: so that
  // spanTouched is set wherever the span changes. Setting the state directly
  // from a picker callback was how an edit could have written a 07:00–15:30
  // default onto a card that had no times at all.
  const applyEndTime = (next: string) => { setSpanTouched(true); setEndTime(next); };
  const applyBreakMinutes = (next: string) => { setSpanTouched(true); setBreakMinutes(next); };

  // Correcting an existing card: the same modal, the same validation and the
  // same Save button, differing only in which verb it ends up calling.
  const openEditForm = (tc: Timecard) => {
    // The control is not rendered on a locked card, so this is the second
    // layer rather than the first — and it is the layer that still holds when
    // the card was approved by somebody else while this list sat on screen.
    if (!isTimecardEditable(statusOf(tc))) {
      Alert.alert("Approved", TIMECARD_LOCKED_MESSAGE);
      void load();
      return;
    }
    resetForm();
    setEditing(tc);
    setWorkerName(tc.workerName);
    setDate(tc.date);
    // openForm declines to PREFILL a new card from a row whose times will not
    // revalidate. Here the opposite is right: these are this card's own
    // values, the person opened it to fix them, and the span message under the
    // Finish field is what tells them which part is wrong. A card with no
    // times keeps the form's defaults on screen but does not send them —
    // spanTouched stays false until the person changes one.
    if (tc.startTime) setStartTime(tc.startTime);
    if (tc.endTime) setEndTime(tc.endTime);
    if (typeof tc.breakMinutes === "number") setBreakMinutes(String(tc.breakMinutes));
    setNotes(tc.notes ?? "");
    setSpanTouched(false);
    // The worker name and the note live behind the "more" toggle, and a
    // correction is usually to one of them, so it starts open on an edit.
    setShowMore(true);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!workerName.trim()) { Alert.alert("Required", "Worker name is required."); return; }
    // The message is already on the Finish field; the Alert is for the case
    // where Save is pressed without the field in view.
    if (spanProblem) { Alert.alert("Check the hours", spanProblem); return; }
    setSaving(true);
    try {
      if (editing) {
        // A PATCH, and deliberately NOT the POST body with an id on it.
        //
        // `siteId` is absent because TimecardUpdateSchema is .strict(): an
        // unknown key is a 400 rather than a silently ignored field, and a
        // timecard does not change site, so the schema says so by refusing it.
        //
        // `trade` is OMITTED rather than sent as "". The route is a true
        // partial update — it writes the fields it is given and leaves the
        // rest of the row alone — so omitting trade preserves whatever the
        // card carries. Sending the "" this screen has no input for would
        // erase it, which is exactly the data loss the partial update exists
        // to prevent, performed by the save button.
        //
        // Start, finish and break go as a SET or not at all, because the API
        // refuses one or two of the three: nothing in the request can check a
        // lone finish time against a start time that exists only in the
        // database. The hours travel with them, being derived from them.
        //
        // And the set goes only when it is this person's to send. A card with
        // no recorded times opens on the form's 07:00–15:30 defaults, and
        // sending those would invent a shift nobody worked.
        const includeSpan = Boolean(editing.startTime && editing.endTime) || spanTouched;
        await apiJson(`/api/crew/timecards/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            workerName: workerName.trim(),
            date,
            notes,
            ...(includeSpan
              ? {
                  startTime,
                  endTime,
                  breakMinutes: Number(breakMinutes) || 0,
                  hoursRegular: computed.regular,
                  hoursOvertime: computed.overtime,
                }
              : {}),
          }),
        });
      } else {
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
      }
      resetForm();
      setShowForm(false);
      await load();
    } catch (err) {
      // A dead session is reported once, centrally, and the app is already
      // on its way to the sign-in screen. This feature must not also blame
      // itself for it - that substitution is the defect, and this exact
      // string is what the device showed when the deploy expired the token.
      if (isSessionExpired(err)) return;
      if (editing && isTimecardLocked(err)) {
        // Approved while the form was open. Nothing in the form can succeed
        // now, so keeping it open would be offering a save that cannot land.
        Alert.alert("Approved", TIMECARD_LOCKED_MESSAGE);
        resetForm();
        setShowForm(false);
        await load();
        return;
      }
      // describeFailure gives a 403 the access sentence and anything else the
      // feature's own wording, which is correct for a feature failure.
      Alert.alert(
        editing ? "Not saved" : "Error",
        describeFailure(err, editing ? "Failed to save the change." : "Failed to save timecard.")
      );
    }
    finally { setSaving(false); }
  };

  // Approve a card, send it back for correction, or reopen one that was
  // approved. Manager+, and the control is not rendered for anybody else — but
  // the gate that matters is requireAtLeast("manager") on the route, because
  // hiding a button is not a permission.
  const handleApproval = (tc: Timecard, status: TimecardApprovalStatus) => {
    const action = APPROVAL_ACTION[status];
    Alert.alert(action.title, action.prompt(tc.workerName), [
      { text: "Cancel", style: "cancel" },
      {
        text: action.confirm,
        style: status === "approved" ? "default" : "destructive",
        onPress: async () => {
          setApprovingId(tc.id);
          try {
            await apiJson(`/api/crew/timecards/${tc.id}/approval`, {
              method: "POST",
              // `status` alone. The API takes an optional note and the portal
              // sends one; this screen has no text input in the card list, and
              // prompting a manager for a reason on a phone in a yard is the
              // portal's job. A send-back from mobile therefore carries no
              // recorded reason — a real gap in the audit trail, named in the
              // confirmation prompt rather than hidden from the person
              // pressing the button.
              body: JSON.stringify({ status }),
            });
            await load();
          } catch (err) {
            if (isSessionExpired(err)) return;
            Alert.alert("Not updated", describeFailure(err, action.failure));
            // The screen's copy of this row is now of unknown accuracy — it
            // may have been approved, reopened or deleted by somebody else.
            // Re-read rather than guess.
            await load();
          } finally {
            setApprovingId(null);
          }
        },
      },
    ]);
  };

  const handleDelete = (tc: Timecard) => {
    Alert.alert("Delete Record", "Remove this timecard entry?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          // This used to be `.catch(() => {})` followed by filtering the row
          // out of local state regardless of what the server said. An
          // approved card would have vanished from the screen while the
          // database kept it — the UI stating something untrue about a
          // seven-year compliance record, and stating it silently. The row now
          // goes only when the server took it, and a refusal is reported in
          // the words that fit the refusal.
          try {
            await apiJson(`/api/crew/timecards/${tc.id}`, { method: "DELETE" });
          } catch (err) {
            if (isSessionExpired(err)) return;
            Alert.alert("Not deleted", describeFailure(err, "Could not delete the timecard."));
            // If this failed because the card was approved, the chip on screen
            // is stale; the reload is what makes it read as locked.
            await load();
            return;
          }
          await load();
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
      // A dead session is reported once, centrally, and the app is already
      // on its way to the sign-in screen. This feature must not also blame
      // itself for it - that substitution is the defect.
      if (isSessionExpired(error)) return;
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
                      {cards.map((tc) => {
                        const status = statusOf(tc);
                        const look = STATUS_STYLE[status];
                        const editable = isTimecardEditable(status);
                        const busy = approvingId === tc.id;
                        return (
                        <View key={tc.id} style={styles.card}>
                          <View style={styles.cardMain}>
                          <View style={styles.cardDateCol}>
                            <Text style={styles.cardDayName}>{new Date(tc.date + "T00:00:00").toLocaleDateString("en-AU", { weekday: "short" })}</Text>
                            <Text style={styles.cardDayNum}>{new Date(tc.date + "T00:00:00").getDate()}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={styles.cardTopRow}>
                              <Text style={styles.cardName}>{tc.workerName}</Text>
                              {/* Every card says where it stands. Without this
                                  the lock on an approved card is invisible
                                  until somebody tries to edit it and is
                                  refused — a refusal arriving as a surprise. */}
                              <View style={[styles.statusChip, { backgroundColor: look.bg, borderColor: look.border }]}>
                                <Ionicons name={look.icon} size={11} color={look.text} />
                                <Text style={[styles.statusChipTxt, { color: look.text }]}>{look.label}</Text>
                              </View>
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
                            {/* Who approved it, and when. On a payroll record
                                the second pair of eyes is the point, so naming
                                them is what makes a self-approval auditable
                                rather than invisible. */}
                            {status === "approved" && !!tc.approvedBy && (
                              <Text style={styles.cardProvenance} numberOfLines={1}>
                                Approved by {tc.approvedBy}
                                {tc.approvedAt ? ` · ${formatDate(tc.approvedAt.slice(0, 10))}` : ""}
                              </Text>
                            )}
                            {/* The reason it came back, when there is one. A
                                send-back from this screen cannot attach one,
                                so this is usually the portal's note. */}
                            {status === "rejected" && !!tc.approvalNote && (
                              <Text style={styles.cardProvenance}>Sent back: {tc.approvalNote}</Text>
                            )}
                          </View>
                          {/* Edit and delete, on an editable card only. The
                              way into an approved card is the manager's Reopen
                              below, not a greyed-out button that refuses. */}
                          {editable && (
                            <View style={styles.cardActions}>
                              <Pressable onPress={() => openEditForm(tc)} hitSlop={8} style={styles.cardActionBtn}>
                                <Ionicons name="create-outline" size={17} color={Colors.textSecondary} />
                              </Pressable>
                              <Pressable onPress={() => handleDelete(tc)} hitSlop={8} style={styles.cardActionBtn}>
                                <Ionicons name="trash-outline" size={17} color={Colors.error} />
                              </Pressable>
                            </View>
                          )}
                          </View>
                          {/* The manager's half. Crew see the chip and no
                              footer at all: approving is the one write on this
                              screen that is deliberately somebody else's. */}
                          {mayApprove && (
                            <View style={styles.cardFooter}>
                              {busy ? (
                                <ActivityIndicator size="small" color={Colors.primary} />
                              ) : status === "approved" ? (
                                <Pressable style={styles.footerBtn} onPress={() => handleApproval(tc, "pending")}>
                                  <Ionicons name="lock-open-outline" size={15} color={Colors.warningText} />
                                  <Text style={[styles.footerBtnTxt, { color: Colors.warningText }]}>Reopen</Text>
                                </Pressable>
                              ) : (
                                <>
                                  {/* A card already sent back is with the
                                      worker, so sending it back again is not
                                      offered — only approving it once the
                                      correction lands. */}
                                  {status === "pending" && (
                                    <Pressable style={styles.footerBtn} onPress={() => handleApproval(tc, "rejected")}>
                                      <Ionicons name="arrow-undo-outline" size={15} color={Colors.errorText} />
                                      <Text style={[styles.footerBtnTxt, { color: Colors.errorText }]}>Send back</Text>
                                    </Pressable>
                                  )}
                                  <Pressable style={[styles.footerBtn, styles.footerBtnPrimary]} onPress={() => handleApproval(tc, "approved")}>
                                    <Ionicons name="checkmark-circle" size={15} color={Colors.white} />
                                    <Text style={[styles.footerBtnTxt, { color: Colors.white }]}>Approve</Text>
                                  </Pressable>
                                </>
                              )}
                            </View>
                          )}
                        </View>
                      );})}
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
                  const wApproved = wCards.filter((c) => statusOf(c) === "approved").length;
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
                        {/* How much of this total is actually approved. The
                            tab is a payroll check, and a bare hours figure
                            reads as a settled number whether or not anybody
                            has signed it off. */}
                        <Text
                          style={[
                            styles.workerApproval,
                            wApproved === wCards.length && { color: Colors.successText },
                          ]}
                        >
                          {wApproved === wCards.length
                            ? "All approved"
                            : `${wApproved} of ${wCards.length} approved`}
                        </Text>
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
            <Text style={styles.modalTitle}>{editing ? "Edit Timecard" : "Add Timecard"}</Text>
            <Pressable onPress={handleSave} disabled={saving} style={[styles.modalSaveBtn, saving && { opacity: 0.6 }]}>
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
                  <Text style={[styles.timeValue, spanProblem ? styles.timeValueProblem : null]}>{formatTime(endTime)}</Text>
                </Pressable>
              </View>
              {spanProblem && (
                <Text style={styles.spanProblemTxt}>{spanProblem}</Text>
              )}
              <View style={[styles.breakBlock, { borderTopWidth: 1, borderTopColor: Colors.borderLight }]}>
                <Text style={styles.inputLabel}>Break</Text>
                <View style={styles.breakChips}>
                  {["0", "15", "30", "45", "60", "90"].map((m) => (
                    <Pressable key={m} onPress={() => applyBreakMinutes(m)} style={[styles.breakChip, breakMinutes === m && styles.breakChipActive]}>
                      <Text style={[styles.breakChipTxt, breakMinutes === m && styles.breakChipTxtActive]}>{m === "0" ? "None" : `${m}m`}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Computed result */}
              {/* The chip reports hours when the span is usable and says so when
                  it is not. It used to show "0.00h regular" for a reversed pair,
                  which reads as a computed answer rather than as a refusal. */}
              {spanProblem ? (
                <View style={styles.computedRow}>
                  <View style={[styles.computedChip, styles.computedChipProblem]}>
                    <Ionicons name="alert-circle" size={14} color={Colors.errorText} />
                    <Text style={[styles.computedTxt, { color: Colors.errorText }]}>Hours cannot be worked out</Text>
                  </View>
                </View>
              ) : (computed.regular > 0 || computed.overtime > 0) && (
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
                    else if (picker === "start") applyStartTime(dateToHHMM(d));
                    else applyEndTime(dateToHHMM(d));
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
                    else if (picker === "start") applyStartTime(dateToHHMM(d));
                    else applyEndTime(dateToHHMM(d));
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
  //
  // The card used to BE the row. It is now a column shell holding that row
  // (cardMain) with the manager's approval footer beneath it, because the two
  // approve controls will not fit beside a date column, a worker name, a
  // status chip and two icon buttons at 400pt — and a footer that wraps into
  // the hours is a button nobody can hit.
  card: { backgroundColor: Colors.surface, borderRadius: 16, borderWidth: 1, borderColor: Colors.border },
  cardMain: { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14 },
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
  cardProvenance: { fontSize: 11, fontFamily: "Inter_500Medium", color: Colors.textTertiary, marginTop: 6 },

  // Status chip, in the card's top row beside the worker name. cardName is
  // flex: 1, so the chip keeps its intrinsic width and the name truncates
  // ahead of it rather than pushing it off the card.
  statusChip: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  statusChipTxt: { fontSize: 10, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.3 },

  // Edit and delete. A column rather than a row: two icons side by side at
  // this size sit closer than a thumb can separate them, and deleting a
  // timecard by missing the edit button is not a recoverable mistake until
  // the bin exists.
  cardActions: { gap: 2, marginTop: 2 },
  cardActionBtn: { padding: 6 },

  // The manager's footer, divided from the card body so it reads as a
  // decision about the card rather than another field on it.
  cardFooter: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 14, paddingBottom: 12, paddingTop: 2, borderTopWidth: 1, borderTopColor: Colors.borderLight },
  footerBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36 },
  footerBtnPrimary: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  footerBtnTxt: { fontSize: 13, fontFamily: "Inter_600SemiBold" },

  // Worker summary
  workerCard: { backgroundColor: Colors.surface, borderRadius: 16, padding: 16, flexDirection: "row", alignItems: "center", gap: 14, borderWidth: 1, borderColor: Colors.border },
  workerAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  workerAvatarText: { fontSize: 18, fontFamily: "Inter_700Bold", color: Colors.white },
  workerName: { fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.text },
  workerTrade: { fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.textSecondary, marginTop: 1 },
  workerStats: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  workerStatItem: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.textSecondary },
  workerStatDot: { fontSize: 12, color: Colors.textTertiary },
  workerApproval: { fontSize: 11, fontFamily: "Inter_600SemiBold", color: Colors.warningText, marginTop: 4 },
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
  timeValueProblem: { color: Colors.errorText },
  spanProblemTxt: { fontSize: 12, fontFamily: "Inter_500Medium", color: Colors.errorText, paddingHorizontal: 12, paddingBottom: 10 },
  computedChipProblem: { backgroundColor: Colors.errorBg },
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
