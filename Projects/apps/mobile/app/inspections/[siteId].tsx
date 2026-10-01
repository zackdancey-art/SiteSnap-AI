import React, { useEffect, useState } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet, Alert,
  ActivityIndicator, TextInput, Modal, KeyboardAvoidingView, Platform,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Svg, { Path } from "react-native-svg";
import * as ImagePicker from "expo-image-picker";
import * as Crypto from "expo-crypto";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import Colors from "@/constants/colors";
import { formatDate } from "@/lib/format";
import { buildHtmlDocument, runReportExport, escapeHtml, buildAnnotationOverlayHtml } from "@/lib/export-utils";
import { EmptyState } from "@/components/EmptyState";
import { SignaturePad } from "@/components/SignaturePad";
import { AnnotatedImage } from "@/components/AnnotatedImage";
import { PhotoAnnotator } from "@/components/PhotoAnnotator";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { useData, uploadPhotos } from "@/lib/data-context";
import { hydratePhotos, savePhotoPayloads, stripPhotoArray } from "@/lib/photo-payload-store";
import { ScreenHeader } from "@/components/ScreenHeader";
import { AnnotationVector, Photo } from "@/lib/types";

type InspectionResult = { item: string; passed: boolean | null; notes: string; na?: boolean; photos?: Photo[] };
type InspectionDefect = { description: string; severity: string; owner: string; dueDate: string | null; status: string };
type Inspection = {
  id: string; siteId: string; name: string; date: string;
  results: InspectionResult[]; status: "pending" | "complete";
  scope: string; areaInspected: string; time: string;
  inspectorName: string; inspectorRole: string; inspectorCompany: string;
  defects: InspectionDefect[]; overallOutcome: string; followUpRequired: boolean;
};
type Template = { id: string; name: string; items: string[] };

type SignatureRole = "inspector" | "manager" | "client";
type Signature = {
  id: string; inspectionId: string; role: SignatureRole; signerName: string;
  signedAt: string; path: string; viewBox: string; contentHash: string;
  status: "active" | "voided"; voidedAt: string | null; voidedReason: string | null;
};

const ROLE_LABELS: Record<SignatureRole, string> = {
  inspector: "Inspector",
  manager: "Site Manager",
  client: "Client",
};

const DEFECT_SEVERITIES = ["low", "medium", "high"];
const DEFECT_STATUSES = ["open", "closed"];

// Fixed logical coordinate space for signature capture. The pad scales any
// touch input into this space so stored paths are stable across devices.
const SIGNATURE_VIEWBOX = "0 0 320 160";

function isAnswered(r: InspectionResult): boolean {
  return r.passed !== null || !!r.na;
}

/** Pass rate excludes both unanswered and N/A items from the denominator. */
function computePassRate(results: InspectionResult[]): number | null {
  const scored = results.filter((r) => r.passed !== null && !r.na);
  if (scored.length === 0) return null;
  const passed = scored.filter((r) => r.passed === true).length;
  return Math.round((passed / scored.length) * 100);
}

/** Single-inspection defensible-inspection report: details, inspector, checklist, defects, summary, sign-off. */
function buildInspectionHtml(insp: Inspection, siteName: string, client: string, signatures: Signature[]): string {
  const rate = computePassRate(insp.results);
  const answered = insp.results.filter(isAnswered).length;

  const checklistRows = insp.results
    .map((r) => {
      const result = r.na
        ? `<span style="color:#6f8095;font-weight:700;">N/A</span>`
        : r.passed === true ? `<span style="color:#166534;font-weight:700;">Pass</span>`
        : r.passed === false ? `<span style="color:#991b1b;font-weight:700;">Fail</span>`
        : `<span style="color:#6f8095;">—</span>`;
      const photos = r.photos ?? [];
      const photosHtml = photos.length
        ? `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">${photos
            .map((p) =>
              p.base64
                ? `<div style="position:relative;width:96px;height:96px;border-radius:8px;overflow:hidden;flex-shrink:0;"><img src="data:${escapeHtml(p.mimeType || "image/jpeg")};base64,${p.base64}" style="width:100%;height:100%;object-fit:cover;display:block;" />${buildAnnotationOverlayHtml(p)}</div>`
                : ""
            )
            .join("")}</div>`
        : "";
      return `<tr><td>${escapeHtml(r.item)}</td><td>${result}</td><td>${escapeHtml(r.notes || "")}${photosHtml}</td></tr>`;
    })
    .join("");

  const defectRows = insp.defects
    .map((d) => `<tr><td>${escapeHtml(d.description)}</td><td>${escapeHtml(d.severity)}</td><td>${escapeHtml(d.owner)}</td><td>${escapeHtml(d.dueDate || "—")}</td><td>${escapeHtml(d.status)}</td></tr>`)
    .join("");

  const activeSigs = signatures.filter((s) => s.status === "active");
  const voidedSigs = signatures.filter((s) => s.status === "voided");

  const signOffBody = activeSigs.length
    ? activeSigs
        .map(
          (sig) => `
            <div style="margin-bottom:16px;">
              <svg viewBox="${escapeHtml(sig.viewBox)}" width="220" height="90"><path d="${escapeHtml(sig.path)}" fill="none" stroke="#0f2b46" stroke-width="2"/></svg>
              <div style="font-size:12px;color:#6f8095;margin-top:4px;">${escapeHtml(sig.signerName)} — ${escapeHtml(ROLE_LABELS[sig.role])} — ${escapeHtml(new Date(sig.signedAt).toLocaleString("en-AU"))}</div>
            </div>
          `
        )
        .join("")
    : `<p>No signatures recorded.</p>`;

  const supersededBody = voidedSigs.length
    ? `
      <div style="margin-top:8px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#6f8095;margin-bottom:6px;">Superseded signatures</div>
        <ul class="checklist">
          ${voidedSigs
            .map(
              (sig) =>
                `<li>${escapeHtml(sig.signerName)} — ${escapeHtml(ROLE_LABELS[sig.role])} — ${escapeHtml(new Date(sig.signedAt).toLocaleString("en-AU"))} — ${escapeHtml(sig.voidedReason || "No reason recorded")}</li>`
            )
            .join("")}
        </ul>
      </div>
    `
    : "";

  return buildHtmlDocument({
    eyebrow: "Inspection Report",
    title: insp.name,
    subtitle: `${siteName}${client ? ` · ${client}` : ""} · ${formatDate(insp.date)}`,
    meta: [
      { label: "Date", value: formatDate(insp.date) },
      { label: "Status", value: insp.status === "complete" ? "Complete" : "Pending" },
      { label: "Pass Rate", value: rate === null ? "—" : `${rate}%` },
      { label: "Answered", value: `${answered}/${insp.results.length}` },
    ],
    body: `
      <section class="section">
        <h2>Inspection details</h2>
        <table class="detail-table">
          <tr><th>Site</th><td>${escapeHtml(siteName)}</td></tr>
          <tr><th>Date</th><td>${escapeHtml(formatDate(insp.date))}</td></tr>
          <tr><th>Scope</th><td>${escapeHtml(insp.scope || "Not recorded")}</td></tr>
          <tr><th>Area Inspected</th><td>${escapeHtml(insp.areaInspected || "Not recorded")}</td></tr>
          <tr><th>Time</th><td>${escapeHtml(insp.time || "Not recorded")}</td></tr>
        </table>
      </section>
      <section class="section">
        <h2>Inspector</h2>
        <table class="detail-table">
          <tr><th>Name</th><td>${escapeHtml(insp.inspectorName || "Not recorded")}</td></tr>
          <tr><th>Role</th><td>${escapeHtml(insp.inspectorRole || "Not recorded")}</td></tr>
          <tr><th>Company</th><td>${escapeHtml(insp.inspectorCompany || "Not recorded")}</td></tr>
        </table>
      </section>
      <section class="section">
        <h2>Checklist</h2>
        <table class="data-table">
          <thead><tr><th>Item</th><th>Result</th><th>Notes</th></tr></thead>
          <tbody>${checklistRows}</tbody>
        </table>
      </section>
      <section class="section">
        <h2>Defects raised</h2>
        ${
          insp.defects.length
            ? `<table class="data-table">
                <thead><tr><th>Description</th><th>Severity</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>${defectRows}</tbody>
              </table>`
            : `<p>No defects raised.</p>`
        }
      </section>
      <section class="section">
        <h2>Summary</h2>
        <table class="detail-table">
          <tr><th>Pass Rate</th><td>${rate === null ? "—" : `${rate}%`}</td></tr>
          <tr><th>Overall Outcome</th><td>${escapeHtml(insp.overallOutcome || "Not recorded")}</td></tr>
          <tr><th>Follow-up Required</th><td>${insp.followUpRequired ? "Yes" : "No"}</td></tr>
        </table>
      </section>
      <section class="section">
        <h2>Sign-off</h2>
        ${signOffBody}
        ${supersededBody}
      </section>
    `,
  });
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await AsyncStorage.getItem("sitesnap.token");
  const base = getApiBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json() as Promise<T>;
}

function normalizeImageMimeType(_mimeType?: string | null) {
  return "image/jpeg";
}

function extractGpsFromExif(exif: Record<string, unknown> | undefined | null): { latitude?: number; longitude?: number } {
  if (!exif) return {};
  const lat = exif["GPSLatitude"] ?? exif["GPS Latitude"];
  const lon = exif["GPSLongitude"] ?? exif["GPS Longitude"];
  const latRef = String(exif["GPSLatitudeRef"] ?? "N");
  const lonRef = String(exif["GPSLongitudeRef"] ?? "E");
  if (typeof lat !== "number" || typeof lon !== "number") return {};
  return {
    latitude: latRef === "S" ? -lat : lat,
    longitude: lonRef === "W" ? -lon : lon,
  };
}

/** Mirrors new-entry.tsx's createStoredPhoto: camera/library asset → compressed, base64-carrying Photo. */
async function createStoredPhoto(asset: ImagePicker.ImagePickerAsset): Promise<Photo> {
  const manipulated = await manipulateAsync(
    asset.uri,
    [],
    {
      compress: 0.55,
      format: SaveFormat.JPEG,
      base64: true,
    }
  );

  const gps = extractGpsFromExif(asset.exif as Record<string, unknown> | undefined | null);

  return {
    id: Crypto.randomUUID(),
    uri: manipulated.uri,
    caption: "",
    timestamp: new Date().toISOString(),
    base64: manipulated.base64 || asset.base64 || "",
    mimeType: normalizeImageMimeType(asset.mimeType),
    ...gps,
  };
}

const DEFAULT_ITEMS = [
  "PPE worn by all workers",
  "Site boundary secured",
  "Fire extinguisher accessible",
  "First aid kit stocked",
  "Hazardous materials stored safely",
  "Electrical equipment checked",
  "Emergency exits clear",
];

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function LabeledInput({
  label, value, onChangeText, onEndEditing, placeholder, multiline,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onEndEditing?: () => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        onEndEditing={onEndEditing}
        placeholder={placeholder}
        placeholderTextColor={Colors.textTertiary}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : undefined}
      />
    </View>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.readOnlyValue}>{value}</Text>
    </View>
  );
}

export default function InspectionsScreen() {
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const { getSite } = useData();
  const site = getSite(siteId);
  const insets = useSafeAreaInsets();

  // Bottom padding for the two bottom-anchored signature sheets.
  //
  // `useTabScreenInsets` from lib/useScreenInsets deliberately does NOT apply
  // here: it is documented as being for the three screens inside (tabs) and it
  // must be called under a TabScreenInsets provider, which this screen is not
  // rendered beneath. So this is the plain inset.
  //
  // The Math.max floor is not padding-for-taste. These sheets are transparent
  // Modals nested inside a `presentationStyle="pageSheet"` Modal, and inside a
  // page sheet UIKit can report a bottom inset of 0 — which is almost certainly
  // why the value being replaced here was a hardcoded 32.
  const sheetPaddingBottom = Math.max(insets.bottom, 20);

  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [showActive, setShowActive] = useState<Inspection | null>(null);
  const [signatures, setSignatures] = useState<Signature[]>([]);

  // Per-checklist-item photo evidence
  const [cameraPermission, requestCameraPermission] = ImagePicker.useCameraPermissions();
  const [pickingPhotoIdx, setPickingPhotoIdx] = useState<number | null>(null);
  const [annotatingTarget, setAnnotatingTarget] = useState<{ idx: number; photo: Photo } | null>(null);

  // New inspection form state
  const [inspName, setInspName] = useState("Safety Inspection");
  const [inspDate, setInspDate] = useState(new Date().toISOString().split("T")[0]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [cScope, setCScope] = useState("");
  const [cArea, setCArea] = useState("");
  const [cTime, setCTime] = useState("");
  const [cInspectorName, setCInspectorName] = useState("");
  const [cInspectorRole, setCInspectorRole] = useState("");
  const [cInspectorCompany, setCInspectorCompany] = useState("");
  const [saving, setSaving] = useState(false);

  // Add-signature modal state
  const [showSignModal, setShowSignModal] = useState(false);
  const [sigRole, setSigRole] = useState<SignatureRole>("inspector");
  const [sigName, setSigName] = useState("");
  const [sigPath, setSigPath] = useState("");
  const [sigSaving, setSigSaving] = useState(false);

  // Void-signature modal state
  const [voidTarget, setVoidTarget] = useState<Signature | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voiding, setVoiding] = useState(false);

  const load = async () => {
    try {
      const [inspData, tplData] = await Promise.all([
        apiJson<{ inspections: Inspection[] }>(`/api/inspections?siteId=${siteId}`),
        apiJson<{ templates: Template[] }>(`/api/inspection-templates`),
      ]);
      // Re-attach base64 from the local payload store (same source hydrateEntriesWithPhotoPayloads
      // reads) so checklist photos are displayable/exportable, matching the entry-photo flow.
      const hydratedInspections = await Promise.all(
        inspData.inspections.map(async (insp) => ({
          ...insp,
          results: await Promise.all(
            insp.results.map(async (r) => ({ ...r, photos: await hydratePhotos(r.photos ?? []) }))
          ),
        }))
      );
      setInspections(hydratedInspections);
      setTemplates(tplData.templates);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [siteId]);

  const getItems = () => {
    if (selectedTemplate) {
      const tpl = templates.find((t) => t.id === selectedTemplate);
      if (tpl) return tpl.items;
    }
    return DEFAULT_ITEMS;
  };

  const handleCreate = async () => {
    if (!inspName.trim()) { Alert.alert("Error", "Inspection name is required."); return; }
    setSaving(true);
    try {
      const items = getItems();
      await apiJson(`/api/inspections`, {
        method: "POST",
        body: JSON.stringify({
          siteId,
          templateId: selectedTemplate || null,
          name: inspName.trim(),
          date: inspDate,
          results: items.map((item) => ({ item, passed: null, notes: "", na: false })),
          scope: cScope.trim(),
          areaInspected: cArea.trim(),
          time: cTime.trim(),
          inspectorName: cInspectorName.trim(),
          inspectorRole: cInspectorRole.trim(),
          inspectorCompany: cInspectorCompany.trim(),
        }),
      });
      setShowForm(false);
      setInspName("Safety Inspection");
      setCScope(""); setCArea(""); setCTime("");
      setCInspectorName(""); setCInspectorRole(""); setCInspectorCompany("");
      await load();
    } catch {
      Alert.alert("Error", "Failed to create inspection.");
    } finally {
      setSaving(false);
    }
  };

  const loadSignatures = async (inspectionId: string) => {
    try {
      const data = await apiJson<{ signatures: Signature[] }>(`/api/inspections/${inspectionId}/signatures`);
      setSignatures(data.signatures);
      return data.signatures;
    } catch {
      return [];
    }
  };

  const openInspection = async (insp: Inspection) => {
    setShowActive(insp);
    await loadSignatures(insp.id);
  };

  const closeActive = () => {
    setShowActive(null);
    setSignatures([]);
  };

  const updateActiveLocal = (patch: Partial<Inspection>) => {
    if (!showActive) return;
    const updated = { ...showActive, ...patch };
    setShowActive(updated);
    setInspections((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  };

  /** PATCHes the active inspection, then re-fetches signatures — editing signed
   *  content auto-voids signatures server-side, so surface that to the user. */
  const patchActive = async (id: string, patch: Record<string, unknown>) => {
    const prevActiveSigIds = new Set(signatures.filter((s) => s.status === "active").map((s) => s.id));
    // Base64 must never reach results_json — strip it (originals AND annotation derivatives)
    // on a deep copy before serializing. The local `showActive`/`inspections` state, updated
    // separately via updateActiveLocal, is untouched and keeps base64 for display/export.
    const outgoingPatch = patch.results
      ? {
          ...patch,
          results: (patch.results as InspectionResult[]).map((r) => ({
            ...r,
            photos: stripPhotoArray(r.photos ?? []),
          })),
        }
      : patch;
    try {
      const { inspection } = await apiJson<{ inspection: Inspection }>(`/api/inspections/${id}`, {
        method: "PATCH",
        body: JSON.stringify(outgoingPatch),
      });
      // The server echoes back the stripped (base64-less) photos — re-hydrate from the local
      // payload store, same as data-context's hydrateEntriesWithPhotoPayloads, so thumbnails
      // don't disappear from the screen after every save.
      const hydratedResults = await Promise.all(
        inspection.results.map(async (r) => ({ ...r, photos: await hydratePhotos(r.photos ?? []) }))
      );
      const hydratedInspection: Inspection = { ...inspection, results: hydratedResults };
      setShowActive((prev) => (prev && prev.id === id ? hydratedInspection : prev));
      setInspections((prev) => prev.map((i) => (i.id === id ? hydratedInspection : i)));
      const newSigs = await loadSignatures(id);
      const stillActive = new Set(newSigs.filter((s) => s.status === "active").map((s) => s.id));
      const flipped = Array.from(prevActiveSigIds).some((sid) => !stillActive.has(sid));
      if (flipped) {
        Alert.alert("Signatures voided", "Editing this inspection automatically voided its existing signatures. Please re-sign.");
      }
    } catch {
      Alert.alert("Error", "Failed to save changes.");
    }
  };

  const handleResultToggle = (idx: number, kind: "pass" | "fail" | "na") => {
    if (!showActive) return;
    const cur = showActive.results[idx];
    let next: InspectionResult;
    if (kind === "pass") {
      next = cur.passed === true ? { ...cur, passed: null, na: false } : { ...cur, passed: true, na: false };
    } else if (kind === "fail") {
      next = cur.passed === false && !cur.na ? { ...cur, passed: null, na: false } : { ...cur, passed: false, na: false };
    } else {
      next = cur.na ? { ...cur, na: false, passed: null } : { ...cur, na: true, passed: null };
    }
    const updated = showActive.results.map((r, i) => (i === idx ? next : r));
    const allAnswered = updated.every(isAnswered);
    const newStatus: Inspection["status"] = allAnswered ? "complete" : "pending";
    updateActiveLocal({ results: updated, status: newStatus });
    void patchActive(showActive.id, { results: updated, status: newStatus });
  };

  const updateResultNotesLocal = (idx: number, notes: string) => {
    if (!showActive) return;
    const updated = showActive.results.map((r, i) => (i === idx ? { ...r, notes } : r));
    updateActiveLocal({ results: updated });
  };

  /** Captures/picks a photo for a checklist item, uploads it via the shared company-bound
   *  upload flow (same path as new-entry), persists its base64 locally, then appends it
   *  (with base64, for on-screen display) to that item's photos and PATCHes. */
  const handleAddResultPhoto = async (idx: number, source: "camera" | "gallery") => {
    if (!showActive || pickingPhotoIdx !== null) return;
    setPickingPhotoIdx(idx);
    try {
      let asset: ImagePicker.ImagePickerAsset | undefined;
      if (source === "camera") {
        if (!cameraPermission?.granted) {
          const result = await requestCameraPermission();
          if (!result.granted) {
            Alert.alert("Permission Required", "Camera access is needed to take photos.");
            return;
          }
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          quality: 0.35,
          base64: true,
          exif: true,
          allowsEditing: false,
        });
        if (!result.canceled) asset = result.assets[0];
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          quality: 0.35,
          base64: true,
        });
        if (!result.canceled) asset = result.assets[0];
      }
      if (!asset) return;

      const photo = await createStoredPhoto(asset);
      const [uploaded] = await uploadPhotos([photo]);
      await savePhotoPayloads([uploaded]);

      const updated = showActive.results.map((r, i) =>
        i === idx ? { ...r, photos: [...(r.photos ?? []), uploaded] } : r
      );
      updateActiveLocal({ results: updated });
      await patchActive(showActive.id, { results: updated });
    } catch (err) {
      console.error("Checklist photo error:", err);
      Alert.alert("Error", "Failed to add photo.");
    } finally {
      setPickingPhotoIdx(null);
    }
  };

  const handleRemoveResultPhoto = (idx: number, photoId: string) => {
    if (!showActive) return;
    const updated = showActive.results.map((r, i) =>
      i === idx ? { ...r, photos: (r.photos ?? []).filter((p) => p.id !== photoId) } : r
    );
    updateActiveLocal({ results: updated });
    void patchActive(showActive.id, { results: updated });
  };

  /** Appends an annotated derivative of an original checklist photo — no new raster, no new
   *  upload; reuses the original's uri/base64/storageKey, exactly like new-entry's
   *  handleSaveAnnotation, but scoped to the checklist item that owns the source photo. */
  const handleSaveResultAnnotation = async (vector: AnnotationVector) => {
    if (!showActive || !annotatingTarget) return;
    const { idx, photo: sourcePhoto } = annotatingTarget;
    const sourceId = sourcePhoto.id;
    const currentPhotos = showActive.results[idx]?.photos ?? [];
    const withOriginalMarked = currentPhotos.map((p) =>
      p.id === sourceId && !p.kind ? { ...p, kind: "original" as const } : p
    );
    const source = withOriginalMarked.find((p) => p.id === sourceId) ?? sourcePhoto;
    const derivative: Photo = {
      id: Crypto.randomUUID(),
      uri: source.uri,
      base64: source.base64,
      mimeType: source.mimeType,
      caption: source.caption,
      timestamp: new Date().toISOString(),
      latitude: source.latitude,
      longitude: source.longitude,
      storagePath: source.storagePath,
      storageKey: source.storageKey,
      kind: "annotated",
      derivedFromId: source.id,
      annotationVector: vector,
    };
    const nextPhotos = [...withOriginalMarked, derivative];
    await savePhotoPayloads([derivative]);

    const updatedResults = showActive.results.map((r, i) => (i === idx ? { ...r, photos: nextPhotos } : r));
    updateActiveLocal({ results: updatedResults });
    setAnnotatingTarget(null);
    await patchActive(showActive.id, { results: updatedResults });
  };

  const updateDefectLocal = (idx: number, patch: Partial<InspectionDefect>) => {
    if (!showActive) return;
    const updated = showActive.defects.map((d, i) => (i === idx ? { ...d, ...patch } : d));
    updateActiveLocal({ defects: updated });
  };

  const handleDefectFieldChange = (idx: number, patch: Partial<InspectionDefect>) => {
    if (!showActive) return;
    const updated = showActive.defects.map((d, i) => (i === idx ? { ...d, ...patch } : d));
    updateActiveLocal({ defects: updated });
    void patchActive(showActive.id, { defects: updated });
  };

  const handleAddDefect = () => {
    if (!showActive) return;
    const updated: InspectionDefect[] = [...showActive.defects, { description: "", severity: "low", owner: "", dueDate: "", status: "open" }];
    updateActiveLocal({ defects: updated });
    void patchActive(showActive.id, { defects: updated });
  };

  const handleRemoveDefect = (idx: number) => {
    if (!showActive) return;
    const updated = showActive.defects.filter((_, i) => i !== idx);
    updateActiveLocal({ defects: updated });
    void patchActive(showActive.id, { defects: updated });
  };

  const handleFollowUpChange = (value: boolean) => {
    if (!showActive) return;
    updateActiveLocal({ followUpRequired: value });
    void patchActive(showActive.id, { followUpRequired: value });
  };

  const handleSaveSignature = async () => {
    if (!showActive || !sigName.trim() || !sigPath) return;
    setSigSaving(true);
    try {
      await apiJson(`/api/inspections/${showActive.id}/signatures`, {
        method: "POST",
        body: JSON.stringify({ role: sigRole, signerName: sigName.trim(), path: sigPath, viewBox: SIGNATURE_VIEWBOX }),
      });
      setShowSignModal(false);
      setSigName(""); setSigPath(""); setSigRole("inspector");
      await loadSignatures(showActive.id);
    } catch {
      Alert.alert("Error", "Failed to save signature.");
    } finally {
      setSigSaving(false);
    }
  };

  const handleConfirmVoid = async () => {
    if (!showActive || !voidTarget || !voidReason.trim()) return;
    setVoiding(true);
    try {
      await apiJson(`/api/inspections/${showActive.id}/signatures/${voidTarget.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason.trim() }),
      });
      setVoidTarget(null);
      setVoidReason("");
      await loadSignatures(showActive.id);
    } catch {
      Alert.alert("Error", "Failed to void signature.");
    } finally {
      setVoiding(false);
    }
  };

  const handleExportInspection = (insp: Inspection) => {
    if (!site) return;
    const html = buildInspectionHtml(insp, site.name, site.client, signatures);
    const base = `sitesnap-inspection-${insp.date}-${insp.id}`;
    Alert.alert("Export Inspection Report", "Choose a format.", [
      { text: "Cancel", style: "cancel" },
      { text: "Word", onPress: () => void runReportExport({ filenameBase: base, html, format: "doc", label: "the inspection report" }) },
      { text: "PDF", onPress: () => void runReportExport({ filenameBase: base, html, format: "pdf", label: "the inspection report" }) },
    ]);
  };

  const handleDelete = (id: string) => {
    Alert.alert("Delete Inspection", "Remove this inspection?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive", onPress: async () => {
          await apiJson(`/api/inspections/${id}`, { method: "DELETE" }).catch(() => {});
          setInspections((prev) => prev.filter((i) => i.id !== id));
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <ScreenHeader
        borderWidth={1}
        variant="light"
        title="Inspections"
        subtitle={site?.name}
        paddingBottom={16}
        paddingTopExtra={16}
        borderColor={Colors.surfaceSecondary}
        backButtonStyle={styles.backBtn}
        titleStyle={styles.headerTitle}
        subtitleStyle={styles.headerSub}
        right={
          <Pressable onPress={() => setShowForm(true)} style={styles.addBtn}>
            <Ionicons name="add" size={22} color={Colors.white} />
          </Pressable>
        }
      />

      {loading
        // An uncoloured ActivityIndicator uses iOS's appearance-adaptive grey,
        // which goes near-white in dark appearance on top of a background that
        // is always Colors.background. Same cause as the date picker.
        ? <ActivityIndicator color={Colors.primary} style={{ marginTop: 40 }} />
        : inspections.length === 0
          ? <EmptyState icon="shield-checkmark-outline" title="No inspections yet" subtitle="Create a safety inspection checklist for this site." ctaLabel="New Inspection" onCta={() => setShowForm(true)} />
          : (
            <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
              {inspections.map((insp) => {
                const rate = computePassRate(insp.results);
                const answered = insp.results.filter(isAnswered).length;
                return (
                  <Pressable key={insp.id} style={styles.card} onPress={() => openInspection(insp)}>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Text style={styles.cardName}>{insp.name}</Text>
                        <View style={[styles.statusBadge, insp.status === "complete" ? styles.badgeComplete : styles.badgePending]}>
                          <Text style={[styles.badgeText, insp.status === "complete" ? styles.badgeCompleteText : styles.badgePendingText]}>
                            {insp.status === "complete" ? "Complete" : "Pending"}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.cardMeta}>{insp.date} · {answered}/{insp.results.length} answered</Text>
                      {rate !== null && (
                        <Text style={[styles.passRate, { color: rate >= 80 ? Colors.success : rate >= 50 ? Colors.warning : Colors.error }]}>
                          {rate}% pass rate
                        </Text>
                      )}
                    </View>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Pressable onPress={(e) => { e.stopPropagation(); handleDelete(insp.id); }} hitSlop={8}>
                        <Ionicons name="trash-outline" size={18} color={Colors.error} />
                      </Pressable>
                      <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          )
      }

      {/* New Inspection Modal */}
      <Modal visible={showForm} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { paddingTop: insets.top + 16 }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>New Inspection</Text>
            <Pressable onPress={() => setShowForm(false)}><Ionicons name="close" size={24} color={Colors.text} /></Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled">
            <TextInput style={styles.input} placeholder="Inspection name" value={inspName} onChangeText={setInspName} placeholderTextColor={Colors.textTertiary} />
            <TextInput style={styles.input} placeholder="Date (YYYY-MM-DD)" value={inspDate} onChangeText={setInspDate} placeholderTextColor={Colors.textTertiary} />
            <TextInput style={styles.input} placeholder="Scope (optional)" value={cScope} onChangeText={setCScope} placeholderTextColor={Colors.textTertiary} />
            <TextInput style={styles.input} placeholder="Area inspected (optional)" value={cArea} onChangeText={setCArea} placeholderTextColor={Colors.textTertiary} />
            <TextInput style={styles.input} placeholder="Time (optional)" value={cTime} onChangeText={setCTime} placeholderTextColor={Colors.textTertiary} />
            <TextInput style={styles.input} placeholder="Inspector name (optional)" value={cInspectorName} onChangeText={setCInspectorName} placeholderTextColor={Colors.textTertiary} />
            <TextInput style={styles.input} placeholder="Inspector role (optional)" value={cInspectorRole} onChangeText={setCInspectorRole} placeholderTextColor={Colors.textTertiary} />
            <TextInput style={styles.input} placeholder="Inspector company (optional)" value={cInspectorCompany} onChangeText={setCInspectorCompany} placeholderTextColor={Colors.textTertiary} />
            {templates.length > 0 && (
              <View>
                <Text style={styles.inputLabel}>Template (optional)</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pressable
                      style={[styles.chip, !selectedTemplate && styles.chipActive]}
                      onPress={() => setSelectedTemplate("")}
                    >
                      <Text style={[styles.chipText, !selectedTemplate && styles.chipTextActive]}>Default ({DEFAULT_ITEMS.length})</Text>
                    </Pressable>
                    {templates.map((tpl) => (
                      <Pressable
                        key={tpl.id}
                        style={[styles.chip, selectedTemplate === tpl.id && styles.chipActive]}
                        onPress={() => setSelectedTemplate(tpl.id)}
                      >
                        <Text style={[styles.chipText, selectedTemplate === tpl.id && styles.chipTextActive]}>{tpl.name} ({tpl.items.length})</Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              </View>
            )}
            <Text style={styles.previewLabel}>{getItems().length} checklist items will be created</Text>
            <Pressable style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={handleCreate} disabled={saving}>
              {saving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.saveBtnText}>Create Inspection</Text>}
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* Active Inspection Modal */}
      <Modal visible={!!showActive} animationType="slide" presentationStyle="pageSheet">
        {showActive && (
          <View style={[styles.modal, { paddingTop: insets.top + 16 }]}>
            <View style={styles.modalHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>{showActive.name}</Text>
                <Text style={{ fontSize: 13, color: Colors.textSecondary, marginTop: 2 }}>{formatDate(showActive.date)}</Text>
              </View>
              <Pressable onPress={() => handleExportInspection(showActive)} hitSlop={8} style={{ marginRight: 16 }}>
                <Ionicons name="download-outline" size={22} color={Colors.primary} />
              </Pressable>
              <Pressable onPress={closeActive}><Ionicons name="close" size={24} color={Colors.text} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }} keyboardShouldPersistTaps="handled">
              {/* 1 · Inspection details */}
              <SectionHeader title="1 · Inspection details" />
              <View style={styles.rowFields}>
                <View style={{ flex: 1 }}><ReadOnlyField label="Site" value={site?.name ?? "—"} /></View>
                <View style={{ flex: 1 }}><ReadOnlyField label="Date" value={formatDate(showActive.date)} /></View>
              </View>
              <LabeledInput
                label="Scope"
                value={showActive.scope}
                onChangeText={(v) => updateActiveLocal({ scope: v })}
                onEndEditing={() => patchActive(showActive.id, { scope: showActive.scope })}
                placeholder="e.g. Weekly WHS walk-through"
              />
              <LabeledInput
                label="Area Inspected"
                value={showActive.areaInspected}
                onChangeText={(v) => updateActiveLocal({ areaInspected: v })}
                onEndEditing={() => patchActive(showActive.id, { areaInspected: showActive.areaInspected })}
                placeholder="e.g. Level 2, North wing"
              />
              <LabeledInput
                label="Time"
                value={showActive.time}
                onChangeText={(v) => updateActiveLocal({ time: v })}
                onEndEditing={() => patchActive(showActive.id, { time: showActive.time })}
                placeholder="HH:MM"
              />

              {/* 2 · Inspector */}
              <SectionHeader title="2 · Inspector" />
              <LabeledInput
                label="Inspector Name"
                value={showActive.inspectorName}
                onChangeText={(v) => updateActiveLocal({ inspectorName: v })}
                onEndEditing={() => patchActive(showActive.id, { inspectorName: showActive.inspectorName })}
                placeholder="Full name"
              />
              <View style={styles.rowFields}>
                <View style={{ flex: 1 }}>
                  <LabeledInput
                    label="Role"
                    value={showActive.inspectorRole}
                    onChangeText={(v) => updateActiveLocal({ inspectorRole: v })}
                    onEndEditing={() => patchActive(showActive.id, { inspectorRole: showActive.inspectorRole })}
                    placeholder="e.g. Site Supervisor"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <LabeledInput
                    label="Company"
                    value={showActive.inspectorCompany}
                    onChangeText={(v) => updateActiveLocal({ inspectorCompany: v })}
                    onEndEditing={() => patchActive(showActive.id, { inspectorCompany: showActive.inspectorCompany })}
                    placeholder="Company name"
                  />
                </View>
              </View>

              {/* 3 · Checklist */}
              <SectionHeader title="3 · Checklist" />
              {showActive.results.map((result, idx) => (
                <View key={idx} style={styles.resultCard}>
                  <Text style={styles.resultItem}>{result.item}</Text>
                  <View style={styles.resultBtns}>
                    <Pressable
                      style={[styles.resultBtn, result.passed === true && styles.resultBtnPass]}
                      onPress={() => handleResultToggle(idx, "pass")}
                    >
                      <Text style={[styles.resultBtnLabel, result.passed === true && styles.resultBtnLabelActive]}>Pass</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.resultBtn, result.passed === false && !result.na && styles.resultBtnFail]}
                      onPress={() => handleResultToggle(idx, "fail")}
                    >
                      <Text style={[styles.resultBtnLabel, result.passed === false && !result.na && styles.resultBtnLabelActive]}>Fail</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.resultBtn, !!result.na && styles.resultBtnNa]}
                      onPress={() => handleResultToggle(idx, "na")}
                    >
                      <Text style={[styles.resultBtnLabel, !!result.na && styles.resultBtnLabelActive]}>N/A</Text>
                    </Pressable>
                  </View>
                  <TextInput
                    style={styles.notesInput}
                    value={result.notes}
                    onChangeText={(v) => updateResultNotesLocal(idx, v)}
                    onEndEditing={() => patchActive(showActive.id, { results: showActive.results })}
                    placeholder="Notes"
                    placeholderTextColor={Colors.textTertiary}
                    multiline
                  />
                  {!!(result.photos && result.photos.length > 0) && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.resultPhotoScroll}
                      contentContainerStyle={styles.resultPhotoScrollContent}
                    >
                      {result.photos!.map((photo) => (
                        <View key={photo.id} style={styles.resultPhotoThumb}>
                          <AnnotatedImage photo={photo} />
                          {photo.kind === "annotated" ? (
                            <View style={styles.photoBadge}>
                              <Text style={styles.photoBadgeText}>Annotated</Text>
                            </View>
                          ) : (
                            <Pressable
                              style={styles.photoAnnotate}
                              onPress={() => setAnnotatingTarget({ idx, photo })}
                            >
                              <Ionicons name="brush-outline" size={12} color={Colors.white} />
                            </Pressable>
                          )}
                          <Pressable
                            style={styles.photoRemove}
                            onPress={() => handleRemoveResultPhoto(idx, photo.id)}
                          >
                            <Ionicons name="close" size={12} color={Colors.white} />
                          </Pressable>
                        </View>
                      ))}
                    </ScrollView>
                  )}
                  <View style={styles.resultPhotoActions}>
                    <Pressable
                      style={[styles.resultPhotoBtn, pickingPhotoIdx !== null && styles.resultPhotoBtnDisabled]}
                      onPress={() => handleAddResultPhoto(idx, "camera")}
                      disabled={pickingPhotoIdx !== null}
                    >
                      {pickingPhotoIdx === idx ? (
                        <ActivityIndicator size="small" color={Colors.primary} />
                      ) : (
                        <Ionicons name="camera-outline" size={16} color={Colors.primary} />
                      )}
                      <Text style={styles.resultPhotoBtnText}>Photo</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.resultPhotoBtn, pickingPhotoIdx !== null && styles.resultPhotoBtnDisabled]}
                      onPress={() => handleAddResultPhoto(idx, "gallery")}
                      disabled={pickingPhotoIdx !== null}
                    >
                      <Ionicons name="images-outline" size={16} color={Colors.primary} />
                      <Text style={styles.resultPhotoBtnText}>Gallery</Text>
                    </Pressable>
                  </View>
                </View>
              ))}

              {/* 4 · Defects raised */}
              <SectionHeader title="4 · Defects raised" />
              {showActive.defects.map((defect, idx) => (
                <View key={idx} style={styles.defectCard}>
                  <TextInput
                    style={styles.input}
                    value={defect.description}
                    onChangeText={(v) => updateDefectLocal(idx, { description: v })}
                    onEndEditing={() => patchActive(showActive.id, { defects: showActive.defects })}
                    placeholder="Defect description"
                    placeholderTextColor={Colors.textTertiary}
                  />
                  <Text style={styles.fieldLabel}>Severity</Text>
                  <View style={styles.chipRow}>
                    {DEFECT_SEVERITIES.map((sev) => (
                      <Pressable
                        key={sev}
                        style={[styles.miniChip, defect.severity === sev && styles.miniChipActive]}
                        onPress={() => handleDefectFieldChange(idx, { severity: sev })}
                      >
                        <Text style={[styles.miniChipText, defect.severity === sev && styles.miniChipTextActive]}>{sev}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <View style={styles.rowFields}>
                    <View style={{ flex: 1 }}>
                      <TextInput
                        style={styles.input}
                        value={defect.owner}
                        onChangeText={(v) => updateDefectLocal(idx, { owner: v })}
                        onEndEditing={() => patchActive(showActive.id, { defects: showActive.defects })}
                        placeholder="Owner"
                        placeholderTextColor={Colors.textTertiary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <TextInput
                        style={styles.input}
                        value={defect.dueDate ?? ""}
                        onChangeText={(v) => updateDefectLocal(idx, { dueDate: v })}
                        onEndEditing={() => patchActive(showActive.id, { defects: showActive.defects })}
                        placeholder="Due (YYYY-MM-DD)"
                        placeholderTextColor={Colors.textTertiary}
                      />
                    </View>
                  </View>
                  <Text style={styles.fieldLabel}>Status</Text>
                  <View style={styles.chipRow}>
                    {DEFECT_STATUSES.map((st) => (
                      <Pressable
                        key={st}
                        style={[styles.miniChip, defect.status === st && styles.miniChipActive]}
                        onPress={() => handleDefectFieldChange(idx, { status: st })}
                      >
                        <Text style={[styles.miniChipText, defect.status === st && styles.miniChipTextActive]}>{st}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Pressable style={styles.removeDefectBtn} onPress={() => handleRemoveDefect(idx)}>
                    <Ionicons name="trash-outline" size={16} color={Colors.error} />
                    <Text style={styles.removeDefectText}>Remove</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable style={styles.addDefectBtn} onPress={handleAddDefect}>
                <Ionicons name="add" size={16} color={Colors.primary} />
                <Text style={styles.addDefectText}>Add defect</Text>
              </Pressable>

              {/* 5 · Summary */}
              <SectionHeader title="5 · Summary" />
              <View style={styles.summaryRow}>
                <Text style={styles.summaryLabel}>Pass Rate</Text>
                <Text style={styles.summaryValue}>
                  {computePassRate(showActive.results) === null ? "—" : `${computePassRate(showActive.results)}%`}
                </Text>
              </View>
              <LabeledInput
                label="Overall Outcome"
                value={showActive.overallOutcome}
                onChangeText={(v) => updateActiveLocal({ overallOutcome: v })}
                onEndEditing={() => patchActive(showActive.id, { overallOutcome: showActive.overallOutcome })}
                placeholder="e.g. Satisfactory, minor defects to close out"
                multiline
              />
              <View style={styles.boolRow}>
                <Text style={styles.fieldLabel}>Follow-up Required</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable style={[styles.boolChip, showActive.followUpRequired && styles.boolChipActive]} onPress={() => handleFollowUpChange(true)}>
                    <Text style={[styles.boolChipText, showActive.followUpRequired && styles.boolChipTextActive]}>Yes</Text>
                  </Pressable>
                  <Pressable style={[styles.boolChip, !showActive.followUpRequired && styles.boolChipActive]} onPress={() => handleFollowUpChange(false)}>
                    <Text style={[styles.boolChipText, !showActive.followUpRequired && styles.boolChipTextActive]}>No</Text>
                  </Pressable>
                </View>
              </View>

              {/* 6 · Sign-off */}
              <SectionHeader title="6 · Sign-off" />
              <Text style={styles.helperText}>Editing a signed inspection automatically voids its signatures — you&apos;ll need to re-sign.</Text>
              {signatures.length === 0 ? (
                <Text style={styles.emptySignatures}>No signatures recorded yet.</Text>
              ) : (
                signatures.map((sig) => (
                  <View key={sig.id} style={styles.signatureCard}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.signatureName}>{sig.signerName}</Text>
                        <Text style={styles.signatureMeta}>{ROLE_LABELS[sig.role]} · {new Date(sig.signedAt).toLocaleString("en-AU")}</Text>
                      </View>
                      <View style={[styles.sigBadge, sig.status === "active" ? styles.sigBadgeActive : styles.sigBadgeVoided]}>
                        <Text style={[styles.sigBadgeText, sig.status === "active" ? styles.sigBadgeTextActive : styles.sigBadgeTextVoided]}>
                          {sig.status === "active" ? "Active" : "Voided"}
                        </Text>
                      </View>
                    </View>
                    <Svg width={160} height={70} viewBox={sig.viewBox} style={{ marginTop: 8 }}>
                      <Path d={sig.path} stroke={Colors.text} strokeWidth={2} fill="none" />
                    </Svg>
                    {sig.status === "voided" && sig.voidedReason ? (
                      <Text style={styles.voidedReason}>Voided: {sig.voidedReason}</Text>
                    ) : null}
                    {sig.status === "active" && (
                      <Pressable style={styles.voidBtn} onPress={() => setVoidTarget(sig)}>
                        <Text style={styles.voidBtnText}>Void</Text>
                      </Pressable>
                    )}
                  </View>
                ))
              )}
              <Pressable style={styles.addSignatureBtn} onPress={() => setShowSignModal(true)}>
                <Ionicons name="create-outline" size={16} color={Colors.white} />
                <Text style={styles.addSignatureBtnText}>Add signature</Text>
              </Pressable>

              <View style={{ height: 24 }} />
            </ScrollView>

            {/* Checklist photo annotation modal */}
            <Modal
              visible={!!annotatingTarget}
              animationType="slide"
              presentationStyle="pageSheet"
              onRequestClose={() => setAnnotatingTarget(null)}
            >
              {annotatingTarget && (
                <PhotoAnnotator
                  photo={annotatingTarget.photo}
                  onSave={(vector) => void handleSaveResultAnnotation(vector)}
                  onCancel={() => setAnnotatingTarget(null)}
                />
              )}
            </Modal>

            {/* Add Signature modal */}
            {/* The canvas and the action row sit OUTSIDE the ScrollView on
                purpose. Two reasons, both load-bearing:

                1. SignaturePad captures a vertical pan. Inside a ScrollView the
                   scroll responder wins that gesture, so a downward stroke would
                   scroll the sheet instead of drawing. Keeping the pad out of the
                   scrollable region removes the conflict rather than tuning it.
                2. It guarantees the two requirements that failed on device: the
                   whole canvas is visible, and Cancel/Save can never overlap it.

                What scrolls instead is the form above — which is what actually
                overflows at the largest Dynamic Type sizes, because the role
                chips wrap to three rows. */}
            <Modal visible={showSignModal} animationType="slide" transparent>
              <KeyboardAvoidingView
                style={styles.sigModalOverlay}
                behavior={Platform.OS === "ios" ? "padding" : "height"}
              >
                <View style={[styles.sigModalCard, { paddingBottom: sheetPaddingBottom }]}>
                  <ScrollView
                    style={styles.sigModalForm}
                    contentContainerStyle={styles.sigModalFormContent}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                  >
                    <Text style={styles.modalTitle}>Add Signature</Text>
                    <TextInput
                      style={[styles.input, { marginTop: 12 }]}
                      value={sigName}
                      onChangeText={setSigName}
                      placeholder="Signer name"
                      placeholderTextColor={Colors.textTertiary}
                    />
                    <View style={[styles.chipRow, { marginTop: 12 }]}>
                      {(Object.keys(ROLE_LABELS) as SignatureRole[]).map((r) => (
                        <Pressable key={r} style={[styles.chip, sigRole === r && styles.chipActive]} onPress={() => setSigRole(r)}>
                          <Text style={[styles.chipText, sigRole === r && styles.chipTextActive]}>{ROLE_LABELS[r]}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </ScrollView>
                  <View style={{ marginTop: 12 }}>
                    <SignaturePad viewBox={SIGNATURE_VIEWBOX} height={160} onChange={setSigPath} />
                  </View>
                  <View style={{ flexDirection: "row", gap: 12, marginTop: 16 }}>
                    <Pressable
                      style={styles.cancelBtn}
                      onPress={() => { setShowSignModal(false); setSigName(""); setSigPath(""); setSigRole("inspector"); }}
                    >
                      <Text style={styles.cancelBtnText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.saveBtn, { flex: 1 }, (!sigName.trim() || !sigPath || sigSaving) && { opacity: 0.5 }]}
                      onPress={handleSaveSignature}
                      disabled={!sigName.trim() || !sigPath || sigSaving}
                    >
                      {sigSaving ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.saveBtnText}>Save</Text>}
                    </Pressable>
                  </View>
                </View>
              </KeyboardAvoidingView>
            </Modal>

            {/* Void Signature modal */}
            {/* Same treatment: this sheet has a multiline TextInput and a
                destructive confirm button, so an un-avoided keyboard hid the
                button the user had to reach. */}
            <Modal visible={!!voidTarget} animationType="slide" transparent>
              <KeyboardAvoidingView
                style={styles.sigModalOverlay}
                behavior={Platform.OS === "ios" ? "padding" : "height"}
              >
                <View style={[styles.sigModalCard, { paddingBottom: sheetPaddingBottom }]}>
                  <Text style={styles.modalTitle}>Void Signature</Text>
                  <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Reason</Text>
                  <TextInput
                    style={[styles.input, styles.inputMultiline, { marginTop: 6 }]}
                    value={voidReason}
                    onChangeText={setVoidReason}
                    placeholder="Why is this signature being voided?"
                    placeholderTextColor={Colors.textTertiary}
                    multiline
                    textAlignVertical="top"
                  />
                  <View style={{ flexDirection: "row", gap: 12, marginTop: 16 }}>
                    <Pressable style={styles.cancelBtn} onPress={() => { setVoidTarget(null); setVoidReason(""); }}>
                      <Text style={styles.cancelBtnText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.saveBtn, { flex: 1, backgroundColor: Colors.error }, (!voidReason.trim() || voiding) && { opacity: 0.5 }]}
                      onPress={handleConfirmVoid}
                      disabled={!voidReason.trim() || voiding}
                    >
                      {voiding ? <ActivityIndicator color={Colors.white} /> : <Text style={styles.saveBtnText}>Void</Text>}
                    </Pressable>
                  </View>
                </View>
              </KeyboardAvoidingView>
            </Modal>
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 17, fontWeight: "700", color: Colors.text },
  headerSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 1 },
  addBtn: { backgroundColor: Colors.primary, borderRadius: 10, padding: 8 },
  card: { backgroundColor: Colors.surface, borderRadius: 14, padding: 16, flexDirection: "row", alignItems: "center", gap: 12, shadowColor: Colors.black, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  cardName: { fontSize: 15, fontWeight: "700", color: Colors.text, flex: 1 },
  cardMeta: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  passRate: { fontSize: 13, fontWeight: "600", marginTop: 4 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeComplete: { backgroundColor: Colors.success + "20" },
  badgePending: { backgroundColor: Colors.warning + "20" },
  badgeText: { fontSize: 11, fontWeight: "700" },
  badgeCompleteText: { color: Colors.success },
  badgePendingText: { color: Colors.warning },
  modal: { flex: 1, backgroundColor: Colors.surface },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: Colors.surfaceSecondary },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  input: { borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 14, fontSize: 15, color: Colors.text, backgroundColor: Colors.surface },
  inputMultiline: { minHeight: 80 },
  inputLabel: { fontSize: 13, color: Colors.textSecondary, marginBottom: 2 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { fontSize: 13, color: Colors.textSecondary, fontWeight: "600" },
  chipTextActive: { color: Colors.white },
  previewLabel: { fontSize: 13, color: Colors.textTertiary, textAlign: "center" },
  saveBtn: { backgroundColor: Colors.primary, borderRadius: 14, padding: 16, alignItems: "center" },
  saveBtnText: { color: Colors.white, fontSize: 16, fontWeight: "700" },

  sectionHeader: {
    fontSize: 13, fontWeight: "800", color: Colors.text,
    textTransform: "uppercase", letterSpacing: 0.6,
    marginTop: 8, marginBottom: 8,
    paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: Colors.accent,
  },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: Colors.text },
  readOnlyValue: { fontSize: 15, color: Colors.textSecondary },
  rowFields: { flexDirection: "row", gap: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },

  resultCard: { backgroundColor: Colors.background, borderRadius: 12, padding: 14, gap: 10 },
  resultItem: { fontSize: 14, color: Colors.text },
  resultBtns: { flexDirection: "row", gap: 8 },
  resultBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1.5, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  resultBtnLabel: { fontSize: 13, fontWeight: "700", color: Colors.textSecondary },
  resultBtnLabelActive: { color: Colors.white },
  resultBtnPass: { backgroundColor: Colors.success, borderColor: Colors.success },
  resultBtnFail: { backgroundColor: Colors.error, borderColor: Colors.error },
  resultBtnNa: { backgroundColor: Colors.textTertiary, borderColor: Colors.textTertiary },
  notesInput: { borderWidth: 1, borderColor: Colors.border, borderRadius: 10, padding: 10, fontSize: 13, color: Colors.text, backgroundColor: Colors.surface, minHeight: 40 },

  resultPhotoScroll: { marginTop: 2 },
  resultPhotoScrollContent: { gap: 8, paddingRight: 4 },
  resultPhotoThumb: { width: 72, height: 72, borderRadius: 10, overflow: "hidden", position: "relative" },
  photoBadge: { position: "absolute", bottom: 4, left: 4, right: 4, paddingVertical: 2, borderRadius: 6, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center" },
  photoBadgeText: { fontSize: 8, fontWeight: "700", color: Colors.white },
  photoAnnotate: { position: "absolute", bottom: 4, left: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  photoRemove: { position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  resultPhotoActions: { flexDirection: "row", gap: 8 },
  resultPhotoBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingVertical: 10, backgroundColor: Colors.surface },
  resultPhotoBtnDisabled: { opacity: 0.5 },
  resultPhotoBtnText: { fontSize: 12, fontWeight: "700", color: Colors.primary },

  defectCard: { backgroundColor: Colors.background, borderRadius: 12, padding: 14, gap: 10 },
  miniChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface },
  miniChipActive: { backgroundColor: Colors.accent, borderColor: Colors.accent },
  miniChipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: "600", textTransform: "capitalize" },
  miniChipTextActive: { color: Colors.white },
  removeDefectBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start" },
  removeDefectText: { fontSize: 12, fontWeight: "700", color: Colors.error },
  addDefectBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1, borderColor: Colors.primary, borderRadius: 12, paddingVertical: 12 },
  addDefectText: { fontSize: 14, fontWeight: "700", color: Colors.primary },

  summaryRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: Colors.background, borderRadius: 12, padding: 14 },
  summaryLabel: { fontSize: 14, color: Colors.text, fontWeight: "600" },
  summaryValue: { fontSize: 16, color: Colors.primary, fontWeight: "800" },
  boolRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  boolChip: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 10, backgroundColor: Colors.surfaceSecondary, borderWidth: 1, borderColor: Colors.border },
  boolChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  boolChipText: { fontSize: 14, color: Colors.text, fontWeight: "600" },
  boolChipTextActive: { color: Colors.white },

  helperText: { fontSize: 12, color: Colors.textTertiary, fontStyle: "italic" },
  emptySignatures: { fontSize: 13, color: Colors.textTertiary },
  signatureCard: { backgroundColor: Colors.background, borderRadius: 12, padding: 14, gap: 4 },
  signatureName: { fontSize: 14, fontWeight: "700", color: Colors.text },
  signatureMeta: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  sigBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  sigBadgeActive: { backgroundColor: Colors.successBg },
  sigBadgeVoided: { backgroundColor: Colors.errorBg },
  sigBadgeText: { fontSize: 11, fontWeight: "700" },
  sigBadgeTextActive: { color: Colors.successText },
  sigBadgeTextVoided: { color: Colors.errorText },
  voidedReason: { fontSize: 12, color: Colors.errorText, marginTop: 4 },
  voidBtn: { alignSelf: "flex-start", marginTop: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Colors.error },
  voidBtnText: { fontSize: 12, fontWeight: "700", color: Colors.error },
  addSignatureBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14 },
  addSignatureBtnText: { fontSize: 14, fontWeight: "700", color: Colors.white },

  sigModalOverlay: { flex: 1, backgroundColor: Colors.overlay, justifyContent: "flex-end" },
  // maxHeight is what stops the card overflowing off the TOP of the screen: it is
  // anchored with justifyContent "flex-end", so without a bound the title and
  // name field are pushed off-screen with no way to scroll them back. The
  // paddingBottom is supplied by the caller from the measured safe-area inset;
  // it used to be a hardcoded 32.
  sigModalCard: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: "92%" },
  sigModalForm: { flexShrink: 1 },
  sigModalFormContent: { paddingBottom: 4 },
  cancelBtn: { paddingHorizontal: 20, paddingVertical: 16, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  cancelBtnText: { fontSize: 15, fontWeight: "700", color: Colors.textSecondary },
});
