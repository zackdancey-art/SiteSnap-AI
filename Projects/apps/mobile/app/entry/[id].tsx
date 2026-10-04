import React from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Platform,
  Alert,
  ActivityIndicator,
  Modal,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import * as Crypto from "expo-crypto";
import { useData } from "@/lib/data-context";
import Colors from "@/constants/colors";
import { Photo, type AnnotationVector } from "@/lib/types";
import { describeCaptureTime } from "@/lib/photo-capture-time";
import {
  buildEntryPhotosReportHtml,
  runReportExport,
  resolvePhotosForExport,
  type ExportPhoto,
} from "@/lib/export-utils";
import { BackButton } from "@/components/BackButton";
import { EvidenceImage, type EvidenceImageStatus } from "@/components/EvidenceImage";
import { PhotoAnnotator } from "@/components/PhotoAnnotator";

export default function EntryDetailScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getEntry, getSite, deleteEntry, updateEntry } = useData();

  const entry = getEntry(id);
  const site = entry ? getSite(entry.siteId) : null;

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;
  const [previewPhoto, setPreviewPhoto] = React.useState<Photo | null>(null);
  const captureTime = previewPhoto ? describeCaptureTime(previewPhoto) : null;
  const [annotatingPhoto, setAnnotatingPhoto] = React.useState<Photo | null>(null);
  const [savingAnnotation, setSavingAnnotation] = React.useState(false);

  /**
   * What each tile actually managed to render. Reported by EvidenceImage rather
   * than inferred from the uri, because a uri can look fine and still fail to
   * load — and the count in the banner must match what the user is looking at.
   */
  const [photoStatuses, setPhotoStatuses] = React.useState<Record<string, EvidenceImageStatus>>({});
  const handlePhotoStatus = React.useCallback((status: EvidenceImageStatus, photoId: string) => {
    setPhotoStatuses((prev) => (prev[photoId] === status ? prev : { ...prev, [photoId]: status }));
  }, []);
  const [preparingExport, setPreparingExport] = React.useState(false);

  if (!entry) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Entry not found</Text>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.backLink}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // Only tiles that have settled on "unavailable" count; a tile still loading is
  // not yet a failure.
  const unavailablePhotoCount = entry.photos.filter(
    (photo) => photoStatuses[photo.id] === "unavailable"
  ).length;

  const handleDelete = () => {
    if (Platform.OS === "web") {
      deleteEntry(id);
      router.back();
      return;
    }
    Alert.alert("Delete Entry", "Remove this daily entry?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteEntry(id);
          router.back();
        },
      },
    ]);
  };

  const handleEdit = () => {
    router.push({
      pathname: "/new-entry",
      params: { siteId: entry.siteId, entryId: entry.id },
    });
  };

  const handleOpenMaps = async () => {
    if (!entry.locationAddress) return;
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(entry.locationAddress)}`;
    const canOpen = await Linking.canOpenURL(url);
    if (!canOpen) return;
    await Linking.openURL(url);
  };

  const dateObj = new Date(entry.date + "T00:00:00");
  const formattedDate = dateObj.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  /**
   * Annotating a saved photograph.
   *
   * THE RULE THIS OBEYS, which is the non-negotiable one: an annotation
   * CREATES A NEW RECORD ALONGSIDE THE ORIGINAL AND NEVER REPLACES IT. The
   * original is the evidence; an annotation is a derived document about it.
   * Nothing in this codebase has ever deleted or versioned a stored object
   * (AUDIT L33), so an overwrite would be unrecoverable.
   *
   * `PhotoAnnotator` makes that easy to honour, because it does not produce an
   * image at all -- it emits a stroke vector, and the derivative reuses the
   * original's bytes and adds the vector on top. So there is exactly one copy
   * of the pixels on the server and two records pointing at it, and the
   * original is reachable forever by its own id.
   *
   * `storageKey`/`storagePath` ARE copied from the original, which the two
   * capture screens' handlers do not do. Without them the derivative is a
   * photograph with no storage address -- precisely the state AUDIT L39
   * describes the server as accepting -- because `uploadPhotoOnce`
   * short-circuits on `isManagedMediaUri(photo.uri)` and returns the record
   * untouched, so nothing downstream ever fills them in.
   */
  const handleSaveAnnotation = async (vector: AnnotationVector) => {
    if (!annotatingPhoto || savingAnnotation) return;
    const sourceId = annotatingPhoto.id;
    const withOriginalMarked = entry.photos.map((p) =>
      p.id === sourceId && !p.kind ? { ...p, kind: "original" as const } : p
    );
    const source = withOriginalMarked.find((p) => p.id === sourceId) ?? annotatingPhoto;
    const derivative: Photo = {
      id: Crypto.randomUUID(),
      uri: source.uri,
      base64: source.base64,
      mimeType: source.mimeType,
      storageKey: source.storageKey,
      storagePath: source.storagePath,
      caption: source.caption,
      // `timestamp` is when this derivative was created. Everything describing
      // the PHOTOGRAPH is inherited: an annotation is a document about the same
      // moment, so it depicts the same capture time, the same place and the
      // same bytes.
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

    setSavingAnnotation(true);
    try {
      // `updateEntry` has no error handling of its own (AUDIT L38) and throws
      // straight out of `apiJson`, so the try/catch is MANDATORY here rather
      // than tidy: without it a failed PATCH closes the sheet silently and the
      // annotation is gone with the screen still showing the old photograph.
      // Awaited before the modal closes so success is reported only once the
      // server has it. The queue redesign L38 actually needs is Part 5's.
      await updateEntry(entry.id, { photos: withOriginalMarked.concat(derivative) });
      setAnnotatingPhoto(null);
    } catch {
      Alert.alert(
        "Annotation Not Saved",
        "The annotation could not be saved. Your markings are still on screen — check your connection and save again. The original photograph is unchanged."
      );
    } finally {
      setSavingAnnotation(false);
    }
  };

  /**
   * Every image is turned into a data URI BEFORE the html is built. The exporter
   * prints a WebView snapshot, so a remote `<img src>` would race the snapshot
   * and print blank; and a photo that cannot be fetched is declared in the
   * document rather than omitted from it.
   */
  const handleExportPhotos = async () => {
    if (!site || entry.photos.length === 0) {
      Alert.alert("No Photos", "This entry has no photos to export.");
      return;
    }
    let photos: ExportPhoto[];
    setPreparingExport(true);
    try {
      photos = await resolvePhotosForExport(entry.photos);
    } catch {
      Alert.alert(
        "Export Failed",
        "The photos for this entry could not be prepared. Check your connection and try again."
      );
      return;
    } finally {
      setPreparingExport(false);
    }
    const notIncluded = photos.filter((photo) => !photo.exportDataUri).length;
    const html = buildEntryPhotosReportHtml({
      site,
      entryDate: formattedDate,
      notes: entry.notes,
      photos,
      notesMode: entry.notesMode,
      hourlyNotes: entry.hourlyNotes,
    });
    // Said before the file is made, not only inside it.
    const prompt =
      notIncluded > 0
        ? `${notIncluded} of ${photos.length} images could not be attached and are marked "IMAGE NOT INCLUDED" in the document. Choose an export format.`
        : "Choose an export format.";
    Alert.alert("Export Entry Photos", prompt, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Word",
        onPress: () =>
          void runReportExport({
            filenameBase: `${site.name}-${entry.date}-entry-photos`,
            html,
            format: "doc",
            label: "these entry photos",
          }),
      },
      {
        text: "PDF",
        onPress: () =>
          void runReportExport({
            filenameBase: `${site.name}-${entry.date}-entry-photos`,
            html,
            format: "pdf",
            label: "these entry photos",
          }),
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + webTopInset + 8 }]}>
        <View style={styles.headerNav}>
          <BackButton tone="onNavy" glyph="arrow-back" size={22} style={styles.backButton} />
          <Text style={styles.headerLabel}>Daily Entry</Text>
          <View style={styles.headerActions}>
            <Pressable onPress={handleEdit} style={styles.headerAction}>
              <Ionicons name="create-outline" size={20} color="rgba(255,255,255,0.8)" />
            </Pressable>
            <Pressable onPress={handleDelete} style={styles.headerAction}>
              <Ionicons name="trash-outline" size={20} color="rgba(255,255,255,0.8)" />
            </Pressable>
          </View>
        </View>
        <Text style={styles.dateText}>{formattedDate}</Text>
        {site && <Text style={styles.siteText}>{site.name}</Text>}
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: 40 + webBottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.infoGrid}>
          {!!entry.weather && (
            <View style={styles.infoCard}>
              <Ionicons name="partly-sunny" size={24} color={Colors.accent} />
              <Text style={styles.infoLabel}>Weather</Text>
              <Text style={styles.infoValue}>{entry.weather}</Text>
            </View>
          )}
          {!!entry.crewCount && (
            <View style={styles.infoCard}>
              <Ionicons name="people" size={24} color={Colors.accent} />
              <Text style={styles.infoLabel}>Crew</Text>
              <Text style={styles.infoValue}>{entry.crewCount} workers</Text>
            </View>
          )}
          <View style={styles.infoCard}>
            <Ionicons name="camera" size={24} color={Colors.accent} />
            <Text style={styles.infoLabel}>Photos</Text>
            <Text style={styles.infoValue}>{entry.photos.length}</Text>
          </View>
        </View>

        {!!entry.locationAddress && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Address</Text>
            <Pressable style={styles.notesCard} onPress={handleOpenMaps}>
              <Text style={styles.notesText}>{entry.locationAddress}</Text>
              <View style={styles.mapHintRow}>
                <Ionicons name="map-outline" size={14} color={Colors.accent} />
                <Text style={styles.mapHintText}>Open in Google Maps</Text>
              </View>
            </Pressable>
          </View>
        )}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes & Observations</Text>
          <View style={styles.notesCard}>
            <Text style={styles.notesText}>{entry.notes}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Photos</Text>
            {entry.photos.length > 0 && (
              <Pressable
                style={styles.exportPhotosButton}
                onPress={() => void handleExportPhotos()}
                disabled={preparingExport}
              >
                {preparingExport ? (
                  <ActivityIndicator size="small" color={Colors.accent} />
                ) : (
                  <Ionicons name="share-outline" size={14} color={Colors.accent} />
                )}
                <Text style={styles.exportPhotosText}>
                  {preparingExport ? "Preparing…" : "Export"}
                </Text>
              </Pressable>
            )}
          </View>
          {unavailablePhotoCount > 0 && (
            <View style={styles.photoWarning}>
              <Ionicons name="alert-circle" size={16} color={Colors.warningText} />
              <Text style={styles.photoWarningText}>
                {unavailablePhotoCount} of {entry.photos.length}{" "}
                {entry.photos.length === 1 ? "photo" : "photos"} cannot be displayed. They are
                marked below, and are flagged as not included in any export.
              </Text>
            </View>
          )}
          {entry.photos.length === 0 ? (
            <View style={styles.noPhotos}>
              <Ionicons name="images-outline" size={36} color={Colors.textTertiary} />
              <Text style={styles.noPhotosText}>No photos attached</Text>
            </View>
          ) : (
            <View style={styles.photoGrid}>
              {entry.photos.map((photo) => (
                <Pressable
                  key={photo.id}
                  style={styles.photoThumb}
                  onPress={() => setPreviewPhoto(photo)}
                >
                  <EvidenceImage
                    photo={photo}
                    style={styles.photoImage}
                    variant="thumb"
                    onStatusChange={handlePhotoStatus}
                  />
                </Pressable>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      <Modal
        visible={!!previewPhoto}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewPhoto(null)}
      >
        <View style={styles.previewBackdrop}>
          <Pressable style={styles.previewClose} onPress={() => setPreviewPhoto(null)}>
            <Ionicons name="close" size={26} color={Colors.white} />
          </Pressable>
          {!!previewPhoto && captureTime && (
            <>
              <ScrollView
                style={styles.previewScroll}
                contentContainerStyle={styles.previewScrollContent}
                maximumZoomScale={4}
                minimumZoomScale={1}
                bouncesZoom
                centerContent
                showsHorizontalScrollIndicator={false}
                showsVerticalScrollIndicator={false}
              >
                <EvidenceImage
                  photo={previewPhoto}
                  style={styles.previewImage}
                  resizeMode="contain"
                  variant="full"
                  tone="dark"
                />
              </ScrollView>
              <View style={styles.previewMeta}>
                {/*
                  This said "Captured <timestamp>" — and `timestamp` is when the
                  record was created, not when the photograph was taken. For a
                  photograph chosen from the gallery those are different dates,
                  so the app was stating a capture time it had never read, with
                  a fallback to the ENTRY's timestamp that was further out
                  still. `describeCaptureTime` says which of the four states
                  this photograph is actually in.
                */}
                <Text
                  style={[
                    styles.previewMetaText,
                    captureTime.state !== "known" && styles.previewMetaUnknown,
                  ]}
                >
                  {captureTime.label}
                </Text>
                {!!previewPhoto.caption && (
                  <Text style={styles.previewCaption}>{previewPhoto.caption}</Text>
                )}

                {/*
                  The route to the annotator that never existed. `PhotoAnnotator`
                  has worked on saved photographs all along; the entry detail
                  view simply had no way to reach it.

                  Offered on the ORIGINAL only. An annotation of an annotation
                  would make `derivedFromId` a chain the viewer, the export and
                  the AI report all treat as one level deep, and there is no
                  reading of "the original is the evidence" in which that is
                  wanted. The original stays annotatable as many times as you
                  like -- each marking is its own new record.

                  It closes the preview before opening the annotator rather than
                  stacking one modal inside another, which iOS handles badly.
                */}
                {previewPhoto.kind !== "annotated" && (
                  <Pressable
                    style={styles.previewAnnotate}
                    onPress={() => {
                      const target = previewPhoto;
                      setPreviewPhoto(null);
                      setAnnotatingPhoto(target);
                    }}
                  >
                    <Ionicons name="brush-outline" size={16} color={Colors.white} />
                    <Text style={styles.previewAnnotateText}>Annotate</Text>
                  </Pressable>
                )}
              </View>
            </>
          )}
        </View>
      </Modal>

      {/*
        Same pattern as `new-entry.tsx`: a page-sheet Modal holding the
        annotator, dismissed by its own Cancel. `onRequestClose` is ignored
        while a save is in flight so the Android back gesture cannot discard
        markings mid-PATCH.
      */}
      <Modal
        visible={!!annotatingPhoto}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          if (!savingAnnotation) setAnnotatingPhoto(null);
        }}
      >
        {annotatingPhoto && (
          <PhotoAnnotator
            photo={annotatingPhoto}
            onSave={handleSaveAnnotation}
            onCancel={() => {
              if (!savingAnnotation) setAnnotatingPhoto(null);
            }}
          />
        )}
        {savingAnnotation && (
          <View style={styles.annotationSaving}>
            <ActivityIndicator size="small" color={Colors.white} />
            <Text style={styles.annotationSavingText}>Saving annotation…</Text>
          </View>
        )}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  notFound: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  notFoundText: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  backLink: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.accent,
  },
  header: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  headerNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerLabel: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  headerAction: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerActions: {
    flexDirection: "row",
    gap: 8,
  },
  dateText: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: Colors.white,
    marginBottom: 4,
  },
  siteText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.6)",
  },
  scrollContent: {
    padding: 16,
    gap: 20,
  },
  infoGrid: {
    flexDirection: "row",
    gap: 10,
  },
  infoCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 14,
    alignItems: "center",
    gap: 6,
    shadowColor: Colors.cardShadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 2,
  },
  infoLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: Colors.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  infoValue: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    textAlign: "center",
  },
  section: {
    gap: 10,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    marginLeft: 4,
  },
  exportPhotosButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: Colors.accent,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: Colors.accent + "10",
  },
  exportPhotosText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.accent,
  },
  notesCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 18,
    shadowColor: Colors.cardShadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 2,
  },
  notesText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    lineHeight: 24,
  },
  mapHintRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  mapHintText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.accent,
  },
  noPhotos: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 32,
    alignItems: "center",
    gap: 8,
  },
  noPhotosText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textTertiary,
  },
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  photoThumb: {
    width: "31%",
    aspectRatio: 1,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: Colors.borderLight,
  },
  photoImage: {
    width: "100%",
    height: "100%",
  },
  photoWarning: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.warningBorder,
    backgroundColor: Colors.warningBg,
  },
  photoWarningText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: "Inter_500Medium",
    color: Colors.warningText,
  },
  previewBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    paddingTop: 56,
  },
  previewClose: {
    position: "absolute",
    top: 56,
    right: 24,
    zIndex: 1,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  previewScroll: {
    flex: 1,
    width: "100%",
  },
  previewScrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  previewImage: {
    width: 340,
    height: 520,
    maxWidth: "100%",
  },
  previewMeta: {
    paddingHorizontal: 20,
    paddingBottom: 24,
    gap: 6,
  },
  previewMetaText: {
    color: Colors.white,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  // Anything other than a real capture time is amber rather than white, so
  // "Date taken unknown" and "Added <date>" cannot be skim-read as "Taken".
  previewMetaUnknown: {
    color: Colors.warning,
  },
  previewAnnotate: {
    marginTop: 6,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  previewAnnotateText: {
    color: Colors.white,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  // Overlaid rather than inline: the annotator owns the whole sheet, and a
  // save must visibly block a second tap without the canvas jumping.
  annotationSaving: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 18,
    backgroundColor: "rgba(0,0,0,0.75)",
  },
  annotationSavingText: {
    color: Colors.white,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  previewCaption: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
});
