import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  Alert,
  ActivityIndicator,
  Modal,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Crypto from "expo-crypto";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { useData, type SaveProgress } from "@/lib/data-context";
import { CAPTION_MAX_LENGTH, createStoredPhoto } from "@/lib/photo-capture";
import Colors from "@/constants/colors";
import { AnnotationVector, HourlyNote, Photo } from "@/lib/types";
import { AddressSuggestion, fetchAddressSuggestions } from "@/lib/geo";
import { saveDraft, loadDraft, clearDraft } from "@/lib/draft-store";
import { PhotoAnnotator } from "@/components/PhotoAnnotator";
import { AnnotatedImage } from "@/components/AnnotatedImage";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";

const DEFAULT_HOUR_START = 7;
const DEFAULT_HOUR_END = 17;

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function buildHourlyWindow(start: number, end: number, existing: HourlyNote[]): HourlyNote[] {
  const byHour = new Map(existing.map((h) => [h.hour, h.note]));
  const next: HourlyNote[] = [];
  for (let h = start; h <= end; h++) {
    next.push({ hour: h, note: byHour.get(h) ?? "" });
  }
  return next;
}

type PhotoWithBase64 = Photo & { base64?: string | null };

type EntryDirtySnapshot = {
  date: string;
  weather: string;
  locationAddress: string;
  crewCount: string;
  notes: string;
  notesMode: "free" | "hourly";
  hourlyNotesJson: string;
  photosJson: string;
};

/**
 * The fingerprint `isDirty` compares, and therefore what the unsaved-changes
 * guard can see.
 *
 * `caption` is in here deliberately. This used to be the id list alone, which
 * was complete when a photograph's only mutable property was whether it was in
 * the list at all. Now that a caption can be typed, an id-only fingerprint
 * means editing ONLY captions leaves `isDirty` false -- so the guard stays
 * disarmed, the swipe-back gesture is live, and the captions are gone with no
 * warning. Adding a field to `Photo` that a person can edit means adding it
 * here.
 */
function snapshotPhotos(photos: PhotoWithBase64[]): string {
  return JSON.stringify(photos.map((p) => [p.id, p.caption ?? ""]));
}

function snapshotHourlyNotes(hourlyNotes: HourlyNote[]): string {
  return JSON.stringify(hourlyNotes.map((h) => ({ hour: h.hour, note: h.note })));
}

export default function NewEntryScreen() {
  const { siteId, entryId } = useLocalSearchParams<{ siteId: string; entryId?: string }>();
  const { addEntry, updateEntry, getSite, getEntry, getSiteEntries, getSiteTemplates } = useData();
  const existingEntry = entryId ? getEntry(entryId) : undefined;
  const site = getSite(existingEntry?.siteId ?? siteId);
  const activeSiteId = existingEntry?.siteId ?? siteId;
  const siteTemplates = getSiteTemplates(activeSiteId);
  const [date, setDate] = useState(existingEntry?.date ?? new Date().toISOString().split("T")[0]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [dateDraft, setDateDraft] = useState(new Date(`${new Date().toISOString().split("T")[0]}T00:00:00`));
  const [weather, setWeather] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [addressLoading, setAddressLoading] = useState(false);
  const [crewCount, setCrewCount] = useState("");
  const [notes, setNotes] = useState("");
  const [notesMode, setNotesMode] = useState<"free" | "hourly">(existingEntry?.notesMode ?? "free");
  const [hourStart, setHourStart] = useState(DEFAULT_HOUR_START);
  const [hourEnd, setHourEnd] = useState(DEFAULT_HOUR_END);
  const [hourlyNotes, setHourlyNotes] = useState<HourlyNote[]>([]);
  const [photos, setPhotos] = useState<PhotoWithBase64[]>([]);
  const [annotatingPhoto, setAnnotatingPhoto] = useState<PhotoWithBase64 | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pickingPhoto, setPickingPhoto] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const [showRolloverBanner, setShowRolloverBanner] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const isEditing = Boolean(entryId);
  const effectiveSiteId = existingEntry?.siteId ?? siteId;

  const weatherOptions = ["Sunny", "Partly Cloudy", "Overcast", "Rain", "Storm", "Windy"];

  const [cameraPermission, requestCameraPermission] = ImagePicker.useCameraPermissions();

  // Stable snapshot of the form's starting values, used to detect unsaved changes.
  // For a new entry this is the blank/default state; for an existing entry it is
  // populated below, inside the same effect that loads the entry's fields.
  const initialSnapshotRef = useRef<EntryDirtySnapshot>({
    date: existingEntry?.date ?? new Date().toISOString().split("T")[0],
    weather: "",
    locationAddress: "",
    crewCount: "",
    notes: "",
    notesMode: "free",
    hourlyNotesJson: snapshotHourlyNotes(buildHourlyWindow(DEFAULT_HOUR_START, DEFAULT_HOUR_END, [])),
    photosJson: snapshotPhotos([]),
  });

  // Populate form when editing an existing entry
  useEffect(() => {
    if (!existingEntry) return;
    setDate(existingEntry.date);
    setWeather(existingEntry.weather);
    setLocationAddress(existingEntry.locationAddress ?? "");
    setCrewCount(existingEntry.crewCount);
    setNotes(existingEntry.notes);
    setPhotos(existingEntry.photos as PhotoWithBase64[]);
    setNotesMode(existingEntry.notesMode ?? "free");
    let snapshotHourStart = DEFAULT_HOUR_START;
    let snapshotHourEnd = DEFAULT_HOUR_END;
    let snapshotHourlySource: HourlyNote[] = [];
    if (existingEntry.hourlyNotes && existingEntry.hourlyNotes.length > 0) {
      const hours = existingEntry.hourlyNotes.map((h) => h.hour);
      snapshotHourStart = Math.min(...hours);
      snapshotHourEnd = Math.max(...hours);
      snapshotHourlySource = existingEntry.hourlyNotes;
      setHourStart(snapshotHourStart);
      setHourEnd(snapshotHourEnd);
      setHourlyNotes(existingEntry.hourlyNotes);
    }
    initialSnapshotRef.current = {
      date: existingEntry.date,
      weather: existingEntry.weather,
      locationAddress: existingEntry.locationAddress ?? "",
      crewCount: existingEntry.crewCount,
      notes: existingEntry.notes,
      notesMode: existingEntry.notesMode ?? "free",
      hourlyNotesJson: snapshotHourlyNotes(buildHourlyWindow(snapshotHourStart, snapshotHourEnd, snapshotHourlySource)),
      photosJson: snapshotPhotos(existingEntry.photos as PhotoWithBase64[]),
    };
  }, [existingEntry]);

  const isDirty =
    date !== initialSnapshotRef.current.date ||
    weather !== initialSnapshotRef.current.weather ||
    locationAddress !== initialSnapshotRef.current.locationAddress ||
    crewCount !== initialSnapshotRef.current.crewCount ||
    notes !== initialSnapshotRef.current.notes ||
    notesMode !== initialSnapshotRef.current.notesMode ||
    snapshotHourlyNotes(hourlyNotes) !== initialSnapshotRef.current.hourlyNotesJson ||
    snapshotPhotos(photos) !== initialSnapshotRef.current.photosJson;
  // Hoisted above the guard below, which needs `saving`. The doc comment for
  // why this state exists at all is with handleSave.
  const [saveProgress, setSaveProgress] = useState<SaveProgress | null>(null);
  const saving = saveProgress !== null;

  // `saving ||`, not `isDirty` alone. The guard disables the iOS sheet's
  // swipe-dismiss while dirty, which covers a save started from a changed form
  // — the fields are not cleared until after it completes, so the form is still
  // dirty throughout. It does NOT cover re-saving an entry that was opened and
  // not edited: isDirty is false there, the gesture is live, and a swipe lands
  // mid-upload. The uploads retry with backoff, so that window is seconds long,
  // not milliseconds.
  const markSaved = useUnsavedChangesGuard(isDirty || saving);

  // Keep hourlyNotes in sync with the [hourStart, hourEnd] window, preserving
  // any notes already entered for hours that remain in range.
  useEffect(() => {
    setHourlyNotes((prev) => buildHourlyWindow(hourStart, hourEnd, prev));
  }, [hourStart, hourEnd]);

  // On mount for new entries: restore draft or offer roll-over from last entry
  useEffect(() => {
    if (isEditing || !effectiveSiteId) return;
    (async () => {
      const draft = await loadDraft(effectiveSiteId);
      if (draft && (draft.notes.trim() || draft.crewCount || draft.locationAddress)) {
        // Restore fields without photos (photos aren't persisted in draft)
        setDate(draft.date);
        setWeather(draft.weather);
        setLocationAddress(draft.locationAddress);
        setCrewCount(draft.crewCount);
        setNotes(draft.notes);
        setDraftSavedAt(draft.savedAt);
        setShowDraftBanner(true);
        return;
      }
      // Offer to roll over from the most recent entry for this site
      const siteEntries = getSiteEntries(effectiveSiteId);
      if (siteEntries.length > 0) {
        setShowRolloverBanner(true);
      }
    })();
  }, [isEditing, effectiveSiteId]);

  // Auto-save draft whenever form fields change (debounced 1.5 s), new entries only
  useEffect(() => {
    if (isEditing || !effectiveSiteId) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      void saveDraft(effectiveSiteId, { siteId: effectiveSiteId, date, weather, locationAddress, crewCount, notes }).then(() => {
        setDraftSavedAt(new Date().toISOString());
      });
    }, 1500);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [isEditing, effectiveSiteId, date, weather, locationAddress, crewCount, notes]);

  const handleDiscardDraft = async () => {
    setShowDraftBanner(false);
    setDraftSavedAt(null);
    await clearDraft(effectiveSiteId);
    // Reset form to blank
    setDate(new Date().toISOString().split("T")[0]);
    setWeather("");
    setLocationAddress("");
    setCrewCount("");
    setNotes("");
    setPhotos([]);
  };

  const handleRolloverLastEntry = () => {
    const siteEntries = getSiteEntries(effectiveSiteId);
    const last = siteEntries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    if (!last) return;
    setWeather(last.weather ?? "");
    setLocationAddress(last.locationAddress ?? "");
    setCrewCount(last.crewCount ?? "");
    setShowRolloverBanner(false);
  };

  useEffect(() => {
    let isCancelled = false;
    const q = locationAddress.trim();
    if (q.length < 3) {
      setAddressSuggestions([]);
      setAddressLoading(false);
      return;
    }

    setAddressLoading(true);
    const timer = setTimeout(async () => {
      try {
        const suggestions = await fetchAddressSuggestions(q);
        if (!isCancelled) {
          setAddressSuggestions(suggestions);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("Address suggestions failed:", error);
          setAddressSuggestions([]);
        }
      } finally {
        if (!isCancelled) {
          setAddressLoading(false);
        }
      }
    }, 250);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [locationAddress]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (notesMode === "hourly") {
      if (!hourlyNotes.some((h) => h.note.trim())) newErrors.notes = "Add at least one hourly note";
    } else if (!notes.trim()) {
      newErrors.notes = "Notes are required";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleDateChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS !== "ios") {
      setShowDatePicker(false);
    }
    if (selectedDate) {
      if (Platform.OS === "ios") {
        setDateDraft(selectedDate);
      } else {
        setDate(selectedDate.toISOString().split("T")[0]);
      }
    }
  };

  const openDatePicker = () => {
    const current = new Date(`${date}T00:00:00`);
    setDateDraft(current);
    setShowDatePicker(true);
  };

  const applyDateDraft = () => {
    setDate(dateDraft.toISOString().split("T")[0]);
    setShowDatePicker(false);
  };

  const formattedDate = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const formattedDraftDate = dateDraft.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const handleTakePhoto = async () => {
    if (pickingPhoto) return;
    setPickingPhoto(true);
    try {
      if (!cameraPermission?.granted) {
        const result = await requestCameraPermission();
        if (!result.granted) {
          Alert.alert("Permission Required", "Camera access is needed to take photos.");
          setPickingPhoto(false);
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

      if (!result.canceled && result.assets[0]) {
        const newPhoto = await createStoredPhoto(result.assets[0], "camera");
        setPhotos((prev) => [...prev, newPhoto]);
      }
    } catch (err) {
      console.error("Camera error:", err);
    }
    setPickingPhoto(false);
  };

  const handlePickFromGallery = async () => {
    if (pickingPhoto) return;
    setPickingPhoto(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.35,
        base64: true,
        // `exif: true` was set on the camera call and NOT on this one, so a
        // gallery photograph arrived with no EXIF block at all — no
        // coordinates, and no `DateTimeOriginal` to read a capture time from.
        // That asymmetry is why a picked photograph could only ever be dated at
        // the moment it was selected.
        exif: true,
        allowsMultipleSelection: true,
        selectionLimit: 0,
      });

      if (!result.canceled && result.assets.length > 0) {
        const newPhotos: Photo[] = await Promise.all(
          result.assets.map((asset) => createStoredPhoto(asset, "gallery"))
        );
        setPhotos((prev) => [...prev, ...newPhotos]);
      }
    } catch (err) {
      console.error("Gallery error:", err);
    }
    setPickingPhoto(false);
  };

  const removePhoto = (id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
  };

  /**
   * Captions are typed straight into the photograph's own record. They are
   * already carried everywhere a `Photo` goes -- the preview modal, the export,
   * and the AI report's input -- so nothing downstream needed changing; the
   * only thing that never existed was a field to type one into.
   *
   * Held in the `photos` state only -- the draft autosave carries the text
   * fields and NOT the photographs (see the `saveDraft` effect, which passes
   * date/weather/location/crew/notes and nothing else), so a caption is no
   * more and no less durable than the photograph it describes. Making either
   * survive a killed app means putting image bytes in the draft store, which
   * is AUDIT L6's problem and not this commit's. What this commit does ensure
   * is that leaving the screen with unsaved captions now warns, via
   * `snapshotPhotos`.
   */
  const updateCaption = (id: string, caption: string) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, caption } : p)));
  };

  const handleSaveAnnotation = (vector: AnnotationVector) => {
    if (!annotatingPhoto) return;
    const sourceId = annotatingPhoto.id;
    setPhotos((prev) => {
      const withOriginalMarked = prev.map((p) =>
        p.id === sourceId && !p.kind ? { ...p, kind: "original" as const } : p
      );
      const source = withOriginalMarked.find((p) => p.id === sourceId) ?? annotatingPhoto;
      const derivative: PhotoWithBase64 = {
        id: Crypto.randomUUID(),
        uri: source.uri,
        base64: source.base64,
        mimeType: source.mimeType,
        // Carried over, which this handler alone was not doing — the
        // inspections screen's equivalent always has. It matters in EDIT mode:
        // the original is already stored, so its uri is a managed path,
        // `uploadPhotoOnce` short-circuits on `isManagedMediaUri` and returns
        // the derivative untouched, and nothing downstream ever fills these in.
        // The result was a photograph with no storage address — the state AUDIT
        // L39 describes the server as accepting. On a fresh capture both are
        // undefined and this is a no-op.
        storageKey: source.storageKey,
        storagePath: source.storagePath,
        caption: source.caption,
        // `timestamp` is when this derivative was created, which is now.
        // Everything describing the PHOTOGRAPH comes from the original: an
        // annotation is a derived document about the same moment, so it depicts
        // the same capture time, the same place, and the same bytes (it reuses
        // the original's uri/base64 and adds a stroke vector — no new raster).
        // Without this the derivative silently reported the annotation time as
        // its capture time.
        timestamp: new Date().toISOString(),
        ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}),
        captureTimeSource: source.captureTimeSource,
        ...(source.contentSha256 ? { contentSha256: source.contentSha256 } : {}),
        latitude: source.latitude,
        longitude: source.longitude,
        kind: "annotated",
        derivedFromId: source.id,
        annotationVector: vector,
      };
      return [...withOriginalMarked, derivative];
    });
    setAnnotatingPhoto(null);
  };

  const adjustHourStart = (delta: number) => {
    setHourStart((prev) => Math.max(0, Math.min(hourEnd - 1, prev + delta)));
  };

  const adjustHourEnd = (delta: number) => {
    setHourEnd((prev) => Math.max(hourStart + 1, Math.min(23, prev + delta)));
  };

  const updateHourlyNote = (hour: number, text: string) => {
    setHourlyNotes((prev) => prev.map((h) => (h.hour === hour ? { ...h, note: text } : h)));
    setErrors((e) => ({ ...e, notes: "" }));
  };

  const applyTemplate = (tmpl: { weather: string; crewCount: string; notesTemplate: string }) => {
    if (tmpl.weather) setWeather(tmpl.weather);
    if (tmpl.crewCount) setCrewCount(tmpl.crewCount);
    if (tmpl.notesTemplate) setNotes(tmpl.notesTemplate);
    setShowTemplatePicker(false);
  };

  /**
   * Describes an in-flight save, or null when no save is running.
   *
   * Saving with photos is slow — the uploads retry with backoff — and this
   * screen used to say nothing at all between the tap and the navigation back,
   * so a save in progress was indistinguishable from a tap the app had ignored.
   * The natural response to that is to tap Save again.
   */
  // Synchronous companion to `saving`. See handleSave for why state cannot do
  // this. `saving` still drives everything the user sees; this only gates entry.
  const savingRef = useRef(false);

  const saveProgressLabel = (progress: SaveProgress) => {
    if (progress.phase === "uploading" && progress.total > 0) {
      // A COMPLETION count, not "currently uploading photo N": uploadPhotos runs
      // the uploads concurrently, so there is no single current photo. Worded to
      // match what the number actually means.
      return `Uploading photos — ${progress.completed} of ${progress.total} done`;
    }
    return isEditing ? "Saving changes…" : "Saving entry…";
  };

  const handleSave = async () => {
    // THE double-tap guard, and a ref because only a ref can do this job.
    //
    // This replaces `if (saving) return;`. That check described this exact race
    // in its own comment — "setState is async, so a fast double-tap can land
    // twice before React re-renders the button" — and then used a value derived
    // from state to defend against it. `saving` is whatever was true when the
    // current render's closure was created, so two taps inside one frame both
    // read the stale `false` and both proceed. The comment was correct about the
    // hazard and the code could not prevent it.
    //
    // A ref is mutated synchronously, so the second tap observes the claim the
    // first tap made. The button's `disabled` and the blocking overlay are still
    // the first line of defence; this is the one that holds inside a single
    // frame.
    //
    // Not observable from the outside, which is the point: if this works you see
    // nothing. What the device check can confirm is the consequence — one entry
    // and one set of uploads per save. Proving the race itself needs a test.
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await runSave();
    } finally {
      // Released on every exit, including a FAILED save and a failed validate.
      // A guard that latches on failure turns one failed save into a screen that
      // can never be saved again without being left and re-entered.
      savingRef.current = false;
      setSaveProgress(null);
    }
  };

  const runSave = async () => {
    if (!validate()) return;
    const savedAt = new Date().toISOString();
    const photosForApi: Photo[] = photos.map((photo) => ({
      ...photo,
      timestamp: photo.timestamp || savedAt,
    }));
    const payload = {
      siteId: existingEntry?.siteId ?? siteId,
      date,
      weather,
      locationAddress: locationAddress.trim(),
      crewCount,
      notes: notes.trim(),
      photos: photosForApi,
      notesMode,
      hourlyNotes,
    };
    // Set before the first await so the indicator is up from the moment of the
    // tap, not from whenever the first upload reports in.
    setSaveProgress({ phase: "uploading", completed: 0, total: photosForApi.length });
    try {
      if (isEditing && entryId) {
        await updateEntry(entryId, payload, setSaveProgress);
      } else {
        await addEntry(payload, setSaveProgress);
        await clearDraft(effectiveSiteId);
      }
      markSaved();
      router.back();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save entry.";
      Alert.alert("Save Failed", message);
    }
    // No `finally` here any more: handleSave owns clearing the indicator and
    // releasing the guard, so both happen on exactly one path. A spinner that
    // keeps spinning after a failed save reports work that has stopped.
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {showDraftBanner && (
          <View style={styles.draftBanner}>
            <Ionicons name="save-outline" size={16} color={Colors.warning} />
            <View style={styles.draftBannerText}>
              <Text style={styles.draftBannerTitle}>Unsaved draft restored</Text>
              <Text style={styles.draftBannerSub}>
                Saved {draftSavedAt ? new Date(draftSavedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "recently"}
              </Text>
            </View>
            <Pressable onPress={() => void handleDiscardDraft()} style={styles.draftBannerDiscard}>
              <Text style={styles.draftBannerDiscardText}>Discard</Text>
            </Pressable>
          </View>
        )}

        {showRolloverBanner && !showDraftBanner && (
          <View style={styles.rolloverBanner}>
            <Ionicons name="copy-outline" size={16} color={Colors.accent} />
            <Text style={styles.rolloverBannerText}>Copy weather, crew & location from last entry?</Text>
            <Pressable onPress={handleRolloverLastEntry} style={styles.rolloverBannerBtn}>
              <Text style={styles.rolloverBannerBtnText}>Copy</Text>
            </Pressable>
            <Pressable onPress={() => setShowRolloverBanner(false)} style={styles.rolloverBannerClose}>
              <Ionicons name="close" size={16} color={Colors.textTertiary} />
            </Pressable>
          </View>
        )}

        {!isEditing && draftSavedAt && !showDraftBanner && (
          <View style={styles.draftSavedIndicator}>
            <Ionicons name="checkmark-circle-outline" size={13} color={Colors.textTertiary} />
            <Text style={styles.draftSavedText}>
              Draft saved {new Date(draftSavedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </Text>
          </View>
        )}

        {!!site && (
          <View style={styles.siteHeader}>
            <View style={styles.siteHeaderIcon}>
              <Ionicons name="business" size={18} color={Colors.accent} />
            </View>
            <View style={styles.siteHeaderText}>
              <Text style={styles.siteHeaderName} numberOfLines={1}>{site.name}</Text>
              <Text style={styles.siteHeaderClient} numberOfLines={1}>{site.client}</Text>
            </View>
          </View>
        )}

        {!isEditing && siteTemplates.length > 0 && (
          <Pressable style={styles.templateButton} onPress={() => setShowTemplatePicker(true)}>
            <Ionicons name="copy-outline" size={18} color={Colors.accent} />
            <Text style={styles.templateButtonText}>Apply Template</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.textSecondary} />
          </Pressable>
        )}

        <Modal
          visible={showTemplatePicker}
          transparent
          animationType="fade"
          onRequestClose={() => setShowTemplatePicker(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>Choose a Template</Text>
              <Text style={styles.templatePickerHint}>Pre-fills weather, crew count, and notes</Text>
              <ScrollView style={styles.templateList} showsVerticalScrollIndicator={false}>
                {siteTemplates.map((tmpl) => (
                  <Pressable
                    key={tmpl.id}
                    style={styles.templateRow}
                    onPress={() => applyTemplate(tmpl)}
                  >
                    <View style={styles.templateRowIcon}>
                      <Ionicons name="document-text-outline" size={18} color={Colors.accent} />
                    </View>
                    <View style={styles.templateRowText}>
                      <Text style={styles.templateRowName}>{tmpl.name}</Text>
                      {(tmpl.weather || tmpl.crewCount) ? (
                        <Text style={styles.templateRowMeta} numberOfLines={1}>
                          {[tmpl.weather, tmpl.crewCount ? `${tmpl.crewCount} crew` : ""].filter(Boolean).join(" · ")}
                        </Text>
                      ) : null}
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={Colors.textSecondary} />
                  </Pressable>
                ))}
              </ScrollView>
              <View style={styles.modalActions}>
                <Pressable style={styles.modalSecondary} onPress={() => setShowTemplatePicker(false)}>
                  <Text style={styles.modalSecondaryText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Date</Text>
          <Pressable style={styles.dateRow} onPress={openDatePicker}>
            <View style={styles.dateIconWrap}>
              <Ionicons name="calendar-outline" size={18} color={Colors.accent} />
            </View>
            <View style={styles.dateTextWrap}>
              <Text style={styles.dateValue}>{formattedDate}</Text>
              <Text style={styles.dateHint}>Tap to change</Text>
            </View>
          </Pressable>
          {showDatePicker && Platform.OS !== "ios" && (
            <DateTimePicker
              value={new Date(`${date}T00:00:00`)}
              mode="date"
              display="default"
              onChange={handleDateChange}
            />
          )}
          {showDatePicker && Platform.OS === "ios" && (
            <Modal visible transparent animationType="fade" onRequestClose={() => setShowDatePicker(false)}>
              <View style={styles.modalBackdrop}>
                <View style={styles.modalCard}>
                  <Text style={styles.modalTitle}>Set Entry Date</Text>
                  <Text style={styles.modalSelectedDate}>{formattedDraftDate}</Text>
                  <DateTimePicker
                    value={dateDraft}
                    mode="date"
                    display="spinner"
                    themeVariant="light"
                    textColor={Colors.text}
                    style={styles.modalDatePicker}
                    onChange={handleDateChange}
                  />
                  <View style={styles.modalActions}>
                    <Pressable style={styles.modalSecondary} onPress={() => setShowDatePicker(false)}>
                      <Text style={styles.modalSecondaryText}>Cancel</Text>
                    </Pressable>
                    <Pressable style={styles.modalPrimary} onPress={applyDateDraft}>
                      <Ionicons name="checkmark" size={18} color={Colors.white} />
                      <Text style={styles.modalPrimaryText}>Set Date</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </Modal>
          )}
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Address / Location</Text>
          <TextInput
            style={styles.input}
            placeholder="Type location to search in Google Maps"
            placeholderTextColor={Colors.textTertiary}
            value={locationAddress}
            onChangeText={setLocationAddress}
          />
          {addressLoading && <Text style={styles.addressLoadingText}>Searching addresses...</Text>}
          {addressSuggestions.length > 0 && (
            <View style={styles.suggestionsCard}>
              {addressSuggestions.map((item) => (
                <Pressable
                  key={`${item.displayName}-${item.lat ?? ""}-${item.lon ?? ""}`}
                  style={styles.suggestionRow}
                  onPress={() => {
                    setLocationAddress(item.displayName);
                    setAddressSuggestions([]);
                  }}
                >
                  <Ionicons name="location-outline" size={16} color={Colors.textSecondary} />
                  <Text numberOfLines={2} style={styles.suggestionText}>
                    {item.displayName}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Weather</Text>
          <View style={styles.chipRow}>
            {weatherOptions.map((w) => (
              <Pressable
                key={w}
                style={[styles.chip, weather === w && styles.chipActive]}
                onPress={() => setWeather(weather === w ? "" : w)}
              >
                <Text style={[styles.chipText, weather === w && styles.chipTextActive]}>{w}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Crew Count</Text>
          <TextInput
            style={styles.input}
            placeholder="Number of workers on site"
            placeholderTextColor={Colors.textTertiary}
            value={crewCount}
            onChangeText={setCrewCount}
            keyboardType="number-pad"
          />
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Photos ({photos.length})</Text>

          {/*
            A vertical list, not the horizontal strip this used to be.
            88x88 thumbnails side by side had nowhere to put a caption, which
            is the whole reason per-photo captions did not exist: the field had
            no room to go. One row per photograph gives each one its own
            caption without shrinking the thumbnail.
          */}
          {photos.length > 0 && (
            <View style={styles.photoList}>
              {photos.map((photo) => (
                <View key={photo.id} style={styles.photoRow}>
                <View style={styles.photoThumb}>
                  <AnnotatedImage photo={photo} />
                  {/*
                    Shown at the moment of attaching, because this is the only
                    point at which the person can still do something about it:
                    retake the photograph, or accept that this one has no date.
                    A gallery image with no readable `DateTimeOriginal` is NOT
                    dated "now" — it is recorded as unknown and labelled here.
                  */}
                  {photo.captureTimeSource === "unknown" && (
                    <View style={styles.photoNoDate}>
                      <Text style={styles.photoNoDateText}>No date</Text>
                    </View>
                  )}
                  {photo.kind === "annotated" ? (
                    <View style={styles.photoBadge}>
                      <Text style={styles.photoBadgeText}>Annotated</Text>
                    </View>
                  ) : (
                    <Pressable
                      style={styles.photoAnnotate}
                      onPress={() => setAnnotatingPhoto(photo)}
                    >
                      <Ionicons name="brush-outline" size={13} color={Colors.white} />
                    </Pressable>
                  )}
                  <Pressable
                    style={styles.photoRemove}
                    onPress={() => removePhoto(photo.id)}
                  >
                    <Ionicons name="close" size={14} color={Colors.white} />
                  </Pressable>
                </View>

                  {/*
                    Plain text, deliberately. These feed the AI narrative
                    report, so what matters is that a builder will actually
                    type in one -- not that it can be formatted.
                  */}
                  <TextInput
                    style={styles.captionInput}
                    placeholder="Caption — what this shows"
                    placeholderTextColor={Colors.textTertiary}
                    value={photo.caption}
                    onChangeText={(text) => updateCaption(photo.id, text)}
                    multiline
                    maxLength={CAPTION_MAX_LENGTH}
                  />
                </View>
              ))}
            </View>
          )}

          <View style={styles.photoActions}>
            <Pressable
              style={[styles.photoButton, pickingPhoto && styles.photoButtonDisabled]}
              onPress={handleTakePhoto}
              disabled={pickingPhoto}
            >
              {pickingPhoto ? (
                <ActivityIndicator size="small" color={Colors.accent} />
              ) : (
                <Ionicons name="camera" size={22} color={Colors.accent} />
              )}
              <Text style={styles.photoButtonText}>Camera</Text>
            </Pressable>

            <Pressable
              style={[styles.photoButton, pickingPhoto && styles.photoButtonDisabled]}
              onPress={handlePickFromGallery}
              disabled={pickingPhoto}
            >
              <Ionicons name="images" size={22} color={Colors.accent} />
              <Text style={styles.photoButtonText}>Gallery</Text>
            </Pressable>
          </View>
        </View>

        <Modal
          visible={!!annotatingPhoto}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setAnnotatingPhoto(null)}
        >
          {annotatingPhoto && (
            <PhotoAnnotator
              photo={annotatingPhoto}
              onSave={handleSaveAnnotation}
              onCancel={() => setAnnotatingPhoto(null)}
            />
          )}
        </Modal>

        <View style={styles.formGroup}>
          <View style={styles.notesHeaderRow}>
            <Text style={styles.label}>Notes & Observations</Text>
            <View style={styles.segmentedControl}>
              <Pressable
                style={[styles.segment, notesMode === "free" && styles.segmentActive]}
                onPress={() => setNotesMode("free")}
              >
                <Text style={[styles.segmentText, notesMode === "free" && styles.segmentTextActive]}>Free</Text>
              </Pressable>
              <Pressable
                style={[styles.segment, notesMode === "hourly" && styles.segmentActive]}
                onPress={() => setNotesMode("hourly")}
              >
                <Text style={[styles.segmentText, notesMode === "hourly" && styles.segmentTextActive]}>Hourly</Text>
              </Pressable>
            </View>
          </View>

          {notesMode === "hourly" ? (
            <View style={styles.hourlyWrap}>
              <View style={styles.hourlyWindowRow}>
                <View style={styles.hourStepper}>
                  <Text style={styles.hourStepperLabel}>Start</Text>
                  <View style={styles.stepperControls}>
                    <Pressable style={styles.stepperBtn} onPress={() => adjustHourStart(-1)} hitSlop={6}>
                      <Ionicons name="remove" size={16} color={Colors.accent} />
                    </Pressable>
                    <Text style={styles.stepperValue}>{formatHour(hourStart)}</Text>
                    <Pressable style={styles.stepperBtn} onPress={() => adjustHourStart(1)} hitSlop={6}>
                      <Ionicons name="add" size={16} color={Colors.accent} />
                    </Pressable>
                  </View>
                </View>
                <View style={styles.hourStepper}>
                  <Text style={styles.hourStepperLabel}>End</Text>
                  <View style={styles.stepperControls}>
                    <Pressable style={styles.stepperBtn} onPress={() => adjustHourEnd(-1)} hitSlop={6}>
                      <Ionicons name="remove" size={16} color={Colors.accent} />
                    </Pressable>
                    <Text style={styles.stepperValue}>{formatHour(hourEnd)}</Text>
                    <Pressable style={styles.stepperBtn} onPress={() => adjustHourEnd(1)} hitSlop={6}>
                      <Ionicons name="add" size={16} color={Colors.accent} />
                    </Pressable>
                  </View>
                </View>
              </View>

              {hourlyNotes.map((entry) => (
                <View key={entry.hour} style={styles.hourlyRow}>
                  <Text style={styles.hourlyRowLabel}>{formatHour(entry.hour)}</Text>
                  <TextInput
                    style={styles.hourlyRowInput}
                    placeholder="Note for this hour..."
                    placeholderTextColor={Colors.textTertiary}
                    value={entry.note}
                    onChangeText={(t) => updateHourlyNote(entry.hour, t)}
                  />
                </View>
              ))}
              {!!errors.notes && <Text style={styles.errorText}>{errors.notes}</Text>}
            </View>
          ) : (
            <>
              <TextInput
                style={[styles.textArea, !!errors.notes && styles.inputError]}
                placeholder="Describe today's work, progress, issues, safety observations..."
                placeholderTextColor={Colors.textTertiary}
                value={notes}
                onChangeText={(t) => { setNotes(t); setErrors((e) => ({ ...e, notes: "" })); }}
                multiline
                textAlignVertical="top"
              />
              {!!errors.notes && <Text style={styles.errorText}>{errors.notes}</Text>}
            </>
          )}
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.saveButtonPressed,
            saving && styles.saveButtonDisabled,
          ]}
          onPress={handleSave}
          disabled={saving}
          accessibilityState={{ disabled: saving, busy: saving }}
        >
          {saving ? (
            <ActivityIndicator size="small" color={Colors.white} />
          ) : (
            <Ionicons name="checkmark" size={22} color={Colors.white} />
          )}
          <Text style={styles.saveButtonText}>
            {saving
              ? saveProgress.phase === "uploading" && saveProgress.total > 0
                ? `Uploading ${saveProgress.completed}/${saveProgress.total}…`
                : "Saving…"
              : isEditing
                ? "Save Changes"
                : "Save Entry"}
          </Text>
        </Pressable>
      </ScrollView>

      {/*
        Blocking overlay, not just a button spinner. The button alone stops the
        button being tapped twice, but leaves every text field and the back
        gesture live during a save that can run for many seconds — so a field
        edited mid-save would be silently dropped (the payload was built before
        the first await), and navigating away mid-save would trip the unsaved-
        changes guard on an entry that is in fact being saved. onRequestClose is
        deliberately a no-op: this is not dismissable, because there is nothing
        the user can usefully do until the save resolves one way or the other.
        It is rendered only while `saving`, so it cannot outlive the operation.
      */}
      <Modal visible={saving} transparent animationType="fade" onRequestClose={() => {}}>
        <View style={styles.savingBackdrop}>
          <View style={styles.savingCard}>
            <ActivityIndicator size="large" color={Colors.accent} />
            <Text style={styles.savingTitle}>
              {saveProgress ? saveProgressLabel(saveProgress) : "Saving…"}
            </Text>
            <Text style={styles.savingSub}>Keep the app open until this finishes.</Text>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 20,
    gap: 20,
    paddingBottom: 40,
  },
  formGroup: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    marginLeft: 4,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    height: 52,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  inputError: {
    borderColor: Colors.error,
  },
  errorText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.error,
    marginLeft: 4,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  dateIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${Colors.accent}14`,
  },
  dateTextWrap: {
    flex: 1,
  },
  dateValue: {
    fontSize: 18,
    fontFamily: Platform.OS === "ios" ? "System" : "Inter_700Bold",
    fontWeight: Platform.OS === "ios" ? "700" : undefined,
    color: Colors.text,
  },
  dateHint: {
    marginTop: 2,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
  },
  addressLoadingText: {
    marginTop: 6,
    marginLeft: 4,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  suggestionsCard: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    overflow: "hidden",
  },
  suggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  suggestionText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  chipText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  chipTextActive: {
    color: Colors.white,
  },
  photoList: {
    marginTop: 4,
    gap: 10,
  },
  photoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  // Matches the thumbnail's height so a row reads as one unit, and grows with
  // the text rather than scrolling inside a 88pt box.
  captionInput: {
    flex: 1,
    minHeight: 88,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    textAlignVertical: "top",
  },
  photoThumb: {
    width: 88,
    height: 88,
    borderRadius: 12,
    overflow: "hidden",
    position: "relative",
  },
  photoRemove: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoAnnotate: {
    position: "absolute",
    bottom: 4,
    left: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  // Top-left, so it cannot collide with the remove control (top-right) or the
  // annotate control / annotated badge (bottom).
  photoNoDate: {
    position: "absolute",
    top: 4,
    left: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: Colors.warning,
  },
  photoNoDateText: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  photoBadge: {
    position: "absolute",
    bottom: 4,
    left: 4,
    right: 4,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
  },
  photoBadgeText: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  photoActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  photoButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: Colors.border,
    borderStyle: "dashed",
    paddingVertical: 18,
  },
  photoButtonDisabled: {
    opacity: 0.5,
  },
  photoButtonText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,43,70,0.36)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modalCard: {
    width: "100%",
    borderRadius: 16,
    backgroundColor: Colors.surface,
    padding: 14,
    gap: 8,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  modalSelectedDate: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    textAlign: "center",
    marginTop: 2,
  },
  modalDatePicker: {
    backgroundColor: Colors.surface,
    height: 180,
  },
  modalSecondary: {
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  modalSecondaryText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textSecondary,
  },
  modalPrimary: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.accent,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  modalPrimaryText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  draftBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Colors.warning + "18",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.warning + "40",
    padding: 12,
  },
  draftBannerText: { flex: 1 },
  draftBannerTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: Colors.warning },
  draftBannerSub: { fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.warning, opacity: 0.8 },
  draftBannerDiscard: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.warning + "60",
  },
  draftBannerDiscardText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.warning },
  rolloverBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.accent + "10",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.accent + "30",
    padding: 12,
  },
  rolloverBannerText: { flex: 1, fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.text },
  rolloverBannerBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: Colors.accent,
  },
  rolloverBannerBtnText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: Colors.white },
  rolloverBannerClose: { padding: 2 },
  draftSavedIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-end",
    marginTop: -10,
  },
  draftSavedText: { fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.textTertiary },
  siteHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  siteHeaderIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
  },
  siteHeaderText: {
    flex: 1,
  },
  siteHeaderName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  siteHeaderClient: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginTop: 1,
  },
  templateButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  templateButtonText: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.accent,
  },
  templatePickerHint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginBottom: 8,
  },
  templateList: {
    maxHeight: 280,
  },
  templateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  templateRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
  },
  templateRowText: {
    flex: 1,
  },
  templateRowName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  templateRowMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginTop: 2,
  },
  textArea: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    minHeight: 140,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    lineHeight: 22,
  },
  notesHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: Colors.surfaceSecondary,
    borderRadius: 10,
    padding: 2,
  },
  segment: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  segmentActive: {
    backgroundColor: Colors.accent,
  },
  segmentText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textSecondary,
  },
  segmentTextActive: {
    color: Colors.white,
  },
  hourlyWrap: {
    gap: 10,
  },
  hourlyWindowRow: {
    flexDirection: "row",
    gap: 12,
  },
  hourStepper: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: 8,
    paddingHorizontal: 12,
    gap: 4,
  },
  hourStepperLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  stepperControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepperBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${Colors.accent}14`,
  },
  stepperValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  hourlyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  hourlyRowLabel: {
    width: 52,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textSecondary,
  },
  hourlyRowInput: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    height: 44,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.accent,
    height: 54,
    borderRadius: 14,
    marginTop: 8,
  },
  saveButtonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  savingBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
    padding: 32,
  },
  savingCard: {
    alignItems: "center",
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 32,
    minWidth: 240,
  },
  savingTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    textAlign: "center",
  },
  savingSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    textAlign: "center",
  },
  saveButtonText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
});
