import React, { useEffect, useState } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet, Alert,
  ActivityIndicator, TextInput, Modal,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Colors from "@/constants/colors";
import { formatDate } from "@/lib/format";
import { buildHtmlDocument, runReportExport, escapeHtml } from "@/lib/export-utils";
import { EmptyState } from "@/components/EmptyState";
import { useData } from "@/lib/data-context";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { ScreenHeader } from "@/components/ScreenHeader";

type Severity = "near-miss" | "minor" | "moderate" | "major" | "critical";
type IncidentType = "near-miss" | "first-aid" | "medical-treatment" | "lost-time" | "property-damage" | "environmental" | "other";
type IncidentStatus = "open" | "investigating" | "closed";
type Treatment = "none" | "first-aid" | "medical" | "hospital";

type Incident = {
  id: string;
  siteId: string;
  date: string;
  time?: string;
  severity: Severity;
  type?: IncidentType;
  locationArea?: string;
  description: string;
  injuredParty: string;
  injuredRole?: string;
  injuredEmployer?: string;
  natureOfInjury?: string;
  bodyPart?: string;
  treatmentRequired?: Treatment;
  witnesses?: string;
  immediateActions?: string;
  rootCause?: string;
  correctiveAction: string;
  reportedBy?: string;
  supervisorNotified?: boolean;
  supervisorName?: string;
  status: IncidentStatus;
};

const SEVERITY_META: Record<Severity, { color: string; label: string }> = {
  "near-miss": { color: Colors.accentLight, label: "Near Miss" },
  minor:       { color: Colors.successBorder, label: "Minor" },
  moderate:    { color: Colors.warningBorder, label: "Moderate" },
  major:       { color: Colors.errorBorder, label: "Major" },
  critical:    { color: Colors.errorText, label: "Critical" },
};

const TYPE_LABELS: Record<IncidentType, string> = {
  "near-miss":          "Near Miss",
  "first-aid":          "First Aid",
  "medical-treatment":  "Medical Treatment",
  "lost-time":          "Lost Time Injury",
  "property-damage":    "Property Damage",
  environmental:        "Environmental",
  other:                "Other",
};

const TREATMENT_LABELS: Record<Treatment, string> = {
  none:        "None Required",
  "first-aid": "First Aid",
  medical:     "Medical Treatment",
  hospital:    "Hospital",
};

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open:          "Open",
  investigating: "Investigating",
  closed:        "Closed",
};

/** Single-incident formal report (compliance/insurance record). */
function buildIncidentHtml(inc: Incident, siteName: string, client: string): string {
  // Structured to mirror WorkSafe NZ's Accident Investigation Form. Each group
  // renders only if it has content; empty groups are omitted from the document,
  // and fields we don't yet capture (property damage, contributing factors,
  // WorkSafe notification, corrective-action owner/due date, investigator,
  // signature) simply slot into their group once the schema adds them.
  const row = (label: string, value?: string | null) =>
    value && value.trim() ? `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value.trim())}</td></tr>` : "";
  const table = (rows: string) => (rows ? `<table class="detail-table">${rows}</table>` : "");
  const section = (title: string, inner: string) =>
    inner.trim() ? `<section class="section"><h2>${escapeHtml(title)}</h2>${inner}</section>` : "";

  const eventDetails = table(
    row("Date", `${formatDate(inc.date)}${inc.time ? ` · ${inc.time}` : ""}`) +
    row("Site", siteName) +
    row("Location", inc.locationArea) +
    row("Severity", SEVERITY_META[inc.severity]?.label ?? inc.severity) +
    row("Type", inc.type ? TYPE_LABELS[inc.type] : "") +
    row("Status", STATUS_LABELS[inc.status])
  );
  const people = table(
    row("Person Involved", [inc.injuredParty, inc.injuredRole, inc.injuredEmployer].filter(Boolean).join(" · ")) +
    row("Witnesses", inc.witnesses) +
    row("Reported By", inc.reportedBy)
  );
  const whatHappened =
    `<p>${escapeHtml(inc.description || "No description recorded.")}</p>` +
    table(row("Nature of Injury", [inc.natureOfInjury, inc.bodyPart].filter(Boolean).join(", ")));
  const immediate = table(
    row("Treatment", inc.treatmentRequired && inc.treatmentRequired !== "none" ? TREATMENT_LABELS[inc.treatmentRequired] : "") +
    row("Immediate Actions", inc.immediateActions)
  );
  const analysis = table(row("Root Cause", inc.rootCause));
  const corrective = table(row("Corrective Actions", inc.correctiveAction));
  const signoff = table(inc.supervisorNotified ? row("Supervisor Notified", inc.supervisorName || "Yes") : "");

  return buildHtmlDocument({
    eyebrow: "Incident Report",
    title: inc.type ? TYPE_LABELS[inc.type] : "Incident",
    subtitle: `${siteName}${client ? ` · ${client}` : ""} · ${formatDate(inc.date)}${inc.time ? ` · ${inc.time}` : ""}`,
    meta: [
      { label: "Date", value: `${formatDate(inc.date)}${inc.time ? ` · ${inc.time}` : ""}` },
      { label: "Severity", value: SEVERITY_META[inc.severity]?.label ?? inc.severity },
      { label: "Type", value: inc.type ? TYPE_LABELS[inc.type] : "—" },
      { label: "Status", value: STATUS_LABELS[inc.status] },
    ],
    body:
      section("1 · Event details", eventDetails) +
      section("2 · People", people) +
      section("3 · What happened", whatHappened) +
      section("4 · Immediate response", immediate) +
      section("5 · Analysis", analysis) +
      section("6 · Corrective actions", corrective) +
      section("7 · Notification & sign-off", signoff),
  });
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await AsyncStorage.getItem("sitesnap.token");
  const base = getApiBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

function SectionHeader({ title }: { title: string }) {
  return <Text style={formStyles.sectionHeader}>{title}</Text>;
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <View style={formStyles.field}>
      <Text style={formStyles.label}>{label}{required ? <Text style={formStyles.required}> *</Text> : null}</Text>
      {children}
    </View>
  );
}

function ChipGroup<T extends string>({
  options, value, onChange, meta,
}: {
  options: T[];
  value: T;
  onChange: (v: T) => void;
  meta?: Record<string, { color: string; label: string }>;
  labels?: Record<string, string>;
}) {
  return (
    <View style={formStyles.chipRow}>
      {options.map((opt) => {
        const active = value === opt;
        const color = meta?.[opt]?.color;
        const label = meta?.[opt]?.label ?? opt;
        return (
          <Pressable
            key={opt}
            style={[
              formStyles.chip,
              active && { backgroundColor: color ?? Colors.accent, borderColor: color ?? Colors.accent },
            ]}
            onPress={() => onChange(opt)}
          >
            <Text style={[formStyles.chipText, active && formStyles.chipTextActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function BoolField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={formStyles.boolRow}>
      <Text style={formStyles.label}>{label}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable style={[formStyles.boolChip, value && formStyles.boolChipActive]} onPress={() => onChange(true)}>
          <Text style={[formStyles.boolChipText, value && formStyles.boolChipTextActive]}>Yes</Text>
        </Pressable>
        <Pressable style={[formStyles.boolChip, !value && formStyles.boolChipActive]} onPress={() => onChange(false)}>
          <Text style={[formStyles.boolChipText, !value && formStyles.boolChipTextActive]}>No</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function IncidentsScreen() {
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const { getSite } = useData();
  const site = getSite(siteId);
  const insets = useSafeAreaInsets();

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state
  const [severity, setSeverity] = useState<Severity>("near-miss");
  const [type, setType] = useState<IncidentType>("near-miss");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [time, setTime] = useState(new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false }));
  const [locationArea, setLocationArea] = useState("");
  const [description, setDescription] = useState("");
  const [injuredParty, setInjuredParty] = useState("");
  const [injuredRole, setInjuredRole] = useState("");
  const [injuredEmployer, setInjuredEmployer] = useState("");
  const [natureOfInjury, setNatureOfInjury] = useState("");
  const [bodyPart, setBodyPart] = useState("");
  const [treatment, setTreatment] = useState<Treatment>("none");
  const [witnesses, setWitnesses] = useState("");
  const [immediateActions, setImmediateActions] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [correctiveAction, setCorrectiveAction] = useState("");
  const [reportedBy, setReportedBy] = useState("");
  const [supervisorNotified, setSupervisorNotified] = useState(false);
  const [supervisorName, setSupervisorName] = useState("");

  const load = async () => {
    try {
      const data = await apiJson<{ incidents: Incident[] }>(`/api/incidents?siteId=${siteId}`);
      setIncidents(data.incidents);
    } catch {
      // silent — common in dev when auth is fresh
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [siteId]);

  const resetForm = () => {
    setSeverity("near-miss"); setType("near-miss");
    setDate(new Date().toISOString().split("T")[0]);
    setTime(new Date().toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false }));
    setLocationArea(""); setDescription(""); setInjuredParty(""); setInjuredRole("");
    setInjuredEmployer(""); setNatureOfInjury(""); setBodyPart(""); setTreatment("none");
    setWitnesses(""); setImmediateActions(""); setRootCause(""); setCorrectiveAction("");
    setReportedBy(""); setSupervisorNotified(false); setSupervisorName("");
  };

  const handleAdd = async () => {
    if (!description.trim()) { Alert.alert("Required", "Please describe what happened."); return; }
    setSaving(true);
    try {
      await apiJson(`/api/incidents`, {
        method: "POST",
        body: JSON.stringify({
          siteId, date, severity, description: description.trim(),
          injuredParty: injuredParty.trim(), correctiveAction: correctiveAction.trim(), status: "open",
          time, type, locationArea: locationArea.trim(), injuredRole: injuredRole.trim(),
          injuredEmployer: injuredEmployer.trim(), natureOfInjury: natureOfInjury.trim(),
          bodyPart: bodyPart.trim(), treatmentRequired: treatment, witnesses: witnesses.trim(),
          immediateActions: immediateActions.trim(), rootCause: rootCause.trim(),
          reportedBy: reportedBy.trim(), supervisorNotified, supervisorName: supervisorName.trim(),
        }),
      });
      setShowForm(false);
      resetForm();
      await load();
    } catch {
      Alert.alert("Error", "Failed to log incident. Please check your connection.");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateStatus = async (id: string, status: IncidentStatus) => {
    await apiJson(`/api/incidents/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }).catch(() => {});
    setIncidents((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
  };

  const handleExportIncident = (inc: Incident) => {
    if (!site) return;
    const html = buildIncidentHtml(inc, site.name, site.client);
    const base = `sitesnap-incident-${inc.date}-${inc.id}`;
    Alert.alert("Export Incident Report", "Choose a format.", [
      { text: "Cancel", style: "cancel" },
      { text: "Word", onPress: () => void runReportExport({ filenameBase: base, html, format: "doc", label: "the incident report" }) },
      { text: "PDF", onPress: () => void runReportExport({ filenameBase: base, html, format: "pdf", label: "the incident report" }) },
    ]);
  };

  const handleDelete = (id: string) => {
    Alert.alert("Delete Incident", "Remove this incident record permanently?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          await apiJson(`/api/incidents/${id}`, { method: "DELETE" }).catch(() => {});
          setIncidents((prev) => prev.filter((i) => i.id !== id));
        },
      },
    ]);
  };

  const severities: Severity[] = ["near-miss", "minor", "moderate", "major", "critical"];
  const types: IncidentType[] = ["near-miss", "first-aid", "medical-treatment", "lost-time", "property-damage", "environmental", "other"];
  const treatments: Treatment[] = ["none", "first-aid", "medical", "hospital"];

  return (
    <View style={styles.container}>
      <ScreenHeader
        variant="navy"
        title="Incident Register"
        subtitle={site?.name}
        paddingBottom={18}
        paddingTopExtra={16}
        backButtonStyle={styles.backBtn}
        titleStyle={styles.headerTitle}
        subtitleStyle={styles.headerSub}
        right={
          <Pressable onPress={() => setShowForm(true)} style={styles.addBtn}>
            <Ionicons name="add" size={22} color={Colors.white} />
            <Text style={styles.addBtnText}>Report</Text>
          </Pressable>
        }
      />

      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : incidents.length === 0 ? (
        <EmptyState
          icon="warning-outline"
          title="No incidents recorded"
          subtitle="Log near-misses and incidents to maintain your safety register and support corrective actions."
          ctaLabel="Report Incident"
          onCta={() => setShowForm(true)}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          {incidents.map((inc) => {
            const sev = SEVERITY_META[inc.severity] ?? { color: Colors.textTertiary, label: inc.severity };
            const expanded = expandedId === inc.id;
            return (
              <Pressable key={inc.id} style={styles.card} onPress={() => setExpandedId(expanded ? null : inc.id)}>
                {/* Card header row */}
                <View style={styles.cardHeader}>
                  <View style={[styles.sevBadge, { backgroundColor: sev.color + "22" }]}>
                    <View style={[styles.sevDot, { backgroundColor: sev.color }]} />
                    <Text style={[styles.sevText, { color: sev.color }]}>{sev.label.toUpperCase()}</Text>
                  </View>
                  <Text style={styles.cardDate}>{formatDate(inc.date)}{inc.time ? ` · ${inc.time}` : ""}</Text>
                  <View style={[styles.statusBadge, inc.status === "closed" && styles.statusClosed, inc.status === "investigating" && styles.statusInvestigating]}>
                    <Text style={styles.statusText}>{STATUS_LABELS[inc.status]}</Text>
                  </View>
                </View>

                {inc.type && <Text style={styles.cardType}>{TYPE_LABELS[inc.type] ?? inc.type}</Text>}
                <Text style={styles.cardDesc} numberOfLines={expanded ? undefined : 2}>{inc.description}</Text>

                {expanded && (
                  <View style={styles.cardDetail}>
                    {/* Grouped to mirror WorkSafe NZ's Accident Investigation Form.
                        Each group shows only if it has content; missing fields
                        slot into their group once the schema adds them. */}
                    {!!inc.locationArea && (
                      <>
                        <Text style={styles.detailGroup}>Event details</Text>
                        <DetailRow icon="location-outline" label="Location" value={inc.locationArea} />
                      </>
                    )}
                    {(!!inc.injuredParty || !!inc.witnesses || !!inc.reportedBy) && (
                      <>
                        <Text style={styles.detailGroup}>People</Text>
                        {!!inc.injuredParty && <DetailRow icon="person-outline" label="Person Involved" value={[inc.injuredParty, inc.injuredRole, inc.injuredEmployer].filter(Boolean).join(" · ")} />}
                        {!!inc.witnesses && <DetailRow icon="people-outline" label="Witnesses" value={inc.witnesses} />}
                        {!!inc.reportedBy && <DetailRow icon="create-outline" label="Reported By" value={inc.reportedBy} />}
                      </>
                    )}
                    {!!inc.natureOfInjury && (
                      <>
                        <Text style={styles.detailGroup}>What happened</Text>
                        <DetailRow icon="bandage-outline" label="Nature of Injury" value={[inc.natureOfInjury, inc.bodyPart].filter(Boolean).join(", ")} />
                      </>
                    )}
                    {((!!inc.treatmentRequired && inc.treatmentRequired !== "none") || !!inc.immediateActions) && (
                      <>
                        <Text style={styles.detailGroup}>Immediate response</Text>
                        {inc.treatmentRequired && inc.treatmentRequired !== "none" && <DetailRow icon="medkit-outline" label="Treatment" value={TREATMENT_LABELS[inc.treatmentRequired]} />}
                        {!!inc.immediateActions && <DetailRow icon="flash-outline" label="Immediate Actions" value={inc.immediateActions} />}
                      </>
                    )}
                    {!!inc.rootCause && (
                      <>
                        <Text style={styles.detailGroup}>Analysis</Text>
                        <DetailRow icon="search-outline" label="Root Cause" value={inc.rootCause} />
                      </>
                    )}
                    {!!inc.correctiveAction && (
                      <>
                        <Text style={styles.detailGroup}>Corrective actions</Text>
                        <DetailRow icon="checkmark-done-outline" label="Corrective Actions" value={inc.correctiveAction} />
                      </>
                    )}
                    {inc.supervisorNotified && (
                      <>
                        <Text style={styles.detailGroup}>Notification & sign-off</Text>
                        <DetailRow icon="call-outline" label="Supervisor Notified" value={inc.supervisorName || "Yes"} />
                      </>
                    )}

                    <View style={styles.cardActions}>
                      {inc.status === "open" && (
                        <Pressable style={[styles.actionBtn, styles.actionBtnAmber]} onPress={() => handleUpdateStatus(inc.id, "investigating")}>
                          <Text style={styles.actionBtnText}>Investigating</Text>
                        </Pressable>
                      )}
                      {inc.status !== "closed" && (
                        <Pressable style={[styles.actionBtn, styles.actionBtnGreen]} onPress={() => handleUpdateStatus(inc.id, "closed")}>
                          <Text style={styles.actionBtnText}>Close</Text>
                        </Pressable>
                      )}
                      <Pressable style={[styles.actionBtn, styles.actionBtnExport]} onPress={() => handleExportIncident(inc)}>
                        <Ionicons name="download-outline" size={14} color={Colors.white} />
                        <Text style={styles.actionBtnText}>Export</Text>
                      </Pressable>
                      <Pressable style={[styles.actionBtn, styles.actionBtnRed]} onPress={() => handleDelete(inc.id)}>
                        <Ionicons name="trash-outline" size={14} color={Colors.white} />
                      </Pressable>
                    </View>
                  </View>
                )}

                <View style={styles.expandRow}>
                  <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={Colors.textTertiary} />
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {/* Report Incident Form */}
      <Modal visible={showForm} animationType="slide" presentationStyle="pageSheet">
        <View style={[formStyles.container, { paddingTop: insets.top + 16 }]}>
          <View style={formStyles.modalHeader}>
            <Pressable onPress={() => { setShowForm(false); resetForm(); }}>
              <Ionicons name="close" size={24} color={Colors.text} />
            </Pressable>
            <Text style={formStyles.modalTitle}>Incident Report</Text>
            <Pressable
              style={[formStyles.submitBtn, saving && { opacity: 0.6 }]}
              onPress={handleAdd}
              disabled={saving}
            >
              {saving ? <ActivityIndicator color={Colors.white} size="small" /> : <Text style={formStyles.submitBtnText}>Submit</Text>}
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={formStyles.scroll} keyboardShouldPersistTaps="handled">
            {/* 1 · Event details */}
            <SectionHeader title="1 · Event details" />
            <Field label="Incident Type" required>
              <ChipGroup options={types} value={type} onChange={setType} meta={Object.fromEntries(types.map((t) => [t, { color: Colors.primary, label: TYPE_LABELS[t] }]))} />
            </Field>
            <Field label="Severity" required>
              <ChipGroup options={severities} value={severity} onChange={setSeverity} meta={SEVERITY_META} />
            </Field>
            <View style={formStyles.rowFields}>
              <View style={{ flex: 1 }}>
                <Field label="Date" required>
                  <TextInput style={formStyles.input} value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Time">
                  <TextInput style={formStyles.input} value={time} onChangeText={setTime} placeholder="HH:MM" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
            </View>
            <Field label="Location / Site Area">
              <TextInput style={formStyles.input} value={locationArea} onChangeText={setLocationArea} placeholder="e.g. Level 2, North face, Plant room" placeholderTextColor={Colors.textTertiary} />
            </Field>

            {/* 2 · People */}
            <SectionHeader title="2 · People" />
            <Field label="Name of Injured / Involved Person">
              <TextInput style={formStyles.input} value={injuredParty} onChangeText={setInjuredParty} placeholder="Full name" placeholderTextColor={Colors.textTertiary} />
            </Field>
            <View style={formStyles.rowFields}>
              <View style={{ flex: 1 }}>
                <Field label="Role / Trade">
                  <TextInput style={formStyles.input} value={injuredRole} onChangeText={setInjuredRole} placeholder="e.g. Electrician" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Employer / Company">
                  <TextInput style={formStyles.input} value={injuredEmployer} onChangeText={setInjuredEmployer} placeholder="Company name" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
            </View>
            <Field label="Witnesses (name, contact)">
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={witnesses}
                onChangeText={setWitnesses}
                placeholder="Name and contact details of any witnesses"
                placeholderTextColor={Colors.textTertiary}
                multiline
                textAlignVertical="top"
              />
            </Field>
            <Field label="Reported By">
              <TextInput style={formStyles.input} value={reportedBy} onChangeText={setReportedBy} placeholder="Your name" placeholderTextColor={Colors.textTertiary} />
            </Field>

            {/* 3 · What happened */}
            <SectionHeader title="3 · What happened" />
            <Field label="Description of Incident" required>
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={description}
                onChangeText={setDescription}
                placeholder="Describe what happened, the sequence of events, and any relevant context…"
                placeholderTextColor={Colors.textTertiary}
                multiline
                textAlignVertical="top"
              />
            </Field>
            <View style={formStyles.rowFields}>
              <View style={{ flex: 1 }}>
                <Field label="Nature of Injury">
                  <TextInput style={formStyles.input} value={natureOfInjury} onChangeText={setNatureOfInjury} placeholder="e.g. Laceration, sprain" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Body Part Affected">
                  <TextInput style={formStyles.input} value={bodyPart} onChangeText={setBodyPart} placeholder="e.g. Left hand" placeholderTextColor={Colors.textTertiary} />
                </Field>
              </View>
            </View>

            {/* 4 · Immediate response */}
            <SectionHeader title="4 · Immediate response" />
            <Field label="Treatment Required">
              <ChipGroup
                options={treatments}
                value={treatment}
                onChange={setTreatment}
                meta={{
                  none:        { color: Colors.textTertiary, label: "None" },
                  "first-aid": { color: Colors.success,      label: "First Aid" },
                  medical:     { color: Colors.accentLight,            label: "Medical" },
                  hospital:    { color: Colors.error,         label: "Hospital" },
                }}
              />
            </Field>
            <Field label="Immediate Actions Taken">
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={immediateActions}
                onChangeText={setImmediateActions}
                placeholder="Describe actions taken immediately after the incident…"
                placeholderTextColor={Colors.textTertiary}
                multiline
                textAlignVertical="top"
              />
            </Field>

            {/* 5 · Analysis */}
            <SectionHeader title="5 · Analysis" />
            <Field label="Root Cause">
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={rootCause}
                onChangeText={setRootCause}
                placeholder="Identify the underlying cause — environment, equipment, procedure, human factors…"
                placeholderTextColor={Colors.textTertiary}
                multiline
                textAlignVertical="top"
              />
            </Field>

            {/* 6 · Corrective actions */}
            <SectionHeader title="6 · Corrective actions" />
            <Field label="Corrective Actions Required">
              <TextInput
                style={[formStyles.input, formStyles.multiline]}
                value={correctiveAction}
                onChangeText={setCorrectiveAction}
                placeholder="Actions to prevent recurrence…"
                placeholderTextColor={Colors.textTertiary}
                multiline
                textAlignVertical="top"
              />
            </Field>

            {/* 7 · Notification & sign-off */}
            <SectionHeader title="7 · Notification & sign-off" />
            <BoolField label="Supervisor Notified?" value={supervisorNotified} onChange={setSupervisorNotified} />
            {supervisorNotified && (
              <Field label="Supervisor Name">
                <TextInput style={formStyles.input} value={supervisorName} onChangeText={setSupervisorName} placeholder="Supervisor's name" placeholderTextColor={Colors.textTertiary} />
              </Field>
            )}

            <View style={{ height: 32 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon as never} size={14} color={Colors.textTertiary} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.15)", alignItems: "center", justifyContent: "center",
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: Colors.white },
  headerSub: { fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 1 },
  addBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.18)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
  },
  addBtnText: { color: Colors.white, fontSize: 14, fontWeight: "700" },
  card: {
    backgroundColor: Colors.surface, borderRadius: 16, padding: 14,
    shadowColor: Colors.black, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  sevBadge: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  sevDot: { width: 7, height: 7, borderRadius: 4 },
  sevText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.4 },
  cardDate: { flex: 1, fontSize: 12, color: Colors.textSecondary, textAlign: "right" },
  statusBadge: {
    backgroundColor: Colors.errorBg, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
  },
  statusClosed: { backgroundColor: Colors.successBg },
  statusInvestigating: { backgroundColor: Colors.warningBg },
  statusText: { fontSize: 10, fontWeight: "800", color: Colors.text },
  cardType: { fontSize: 11, color: Colors.textTertiary, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 },
  cardDesc: { fontSize: 14, color: Colors.text, lineHeight: 20 },
  cardDetail: { marginTop: 12, gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.border },
  detailGroup: { fontSize: 11, fontWeight: "700", color: Colors.accent, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 8, marginBottom: -2 },
  detailRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  detailLabel: { fontSize: 11, color: Colors.textTertiary, textTransform: "uppercase", letterSpacing: 0.2 },
  detailValue: { fontSize: 13, color: Colors.text, lineHeight: 18 },
  cardActions: { flexDirection: "row", gap: 8, marginTop: 8 },
  actionBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7, alignItems: "center", justifyContent: "center" },
  actionBtnGreen: { backgroundColor: Colors.success },
  actionBtnAmber: { backgroundColor: Colors.accentLight },
  actionBtnRed: { backgroundColor: Colors.error },
  actionBtnExport: { backgroundColor: Colors.primary, flexDirection: "row", gap: 5 },
  actionBtnText: { color: Colors.white, fontSize: 13, fontWeight: "700" },
  expandRow: { alignItems: "center", marginTop: 6 },
});

const formStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.surface },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: Colors.surfaceSecondary,
  },
  modalTitle: { fontSize: 17, fontWeight: "700", color: Colors.text },
  submitBtn: {
    backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8,
  },
  submitBtnText: { color: Colors.white, fontSize: 14, fontWeight: "700" },
  scroll: { padding: 20, gap: 12 },
  sectionHeader: {
    fontSize: 13, fontWeight: "800", color: Colors.text,
    textTransform: "uppercase", letterSpacing: 0.6,
    marginTop: 8, marginBottom: 8,
    paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: "600", color: Colors.text },
  required: { color: Colors.error },
  input: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: 12,
    padding: 12, fontSize: 14, color: Colors.text, backgroundColor: Colors.background,
  },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  rowFields: { flexDirection: "row", gap: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary, borderWidth: 1, borderColor: Colors.border,
  },
  chipText: { fontSize: 13, color: Colors.text, fontWeight: "600" },
  chipTextActive: { color: Colors.white },
  boolRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  boolChip: {
    paddingHorizontal: 20, paddingVertical: 8, borderRadius: 10,
    backgroundColor: Colors.surfaceSecondary, borderWidth: 1, borderColor: Colors.border,
  },
  boolChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  boolChipText: { fontSize: 14, color: Colors.text, fontWeight: "600" },
  boolChipTextActive: { color: Colors.white },
});
