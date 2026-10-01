import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import Colors from "@/constants/colors";
import { useData } from "@/lib/data-context";
import { Photo } from "@/lib/types";
import {
  buildExportImageMarkup,
  buildHtmlDocument,
  buildIncompleteRecordNotice,
  runReportExport,
  formatPhotoCountForExport,
  resolvePhotosForExport,
  sharePhotoFile,
  writeSharablePhotoFile,
} from "@/lib/export-utils";
import { ScreenHeader } from "@/components/ScreenHeader";
import { EvidenceImage, type EvidenceImageStatus } from "@/components/EvidenceImage";

type GalleryItem = {
  id: string;
  siteName: string;
  entryDate: string;
  timestamp: string;
  notes: string;
  photo: Photo;
};

export default function DiaryGalleryScreen() {
  const { siteId } = useLocalSearchParams<{ siteId: string }>();
  const data = useData();
  const safeSiteId = typeof siteId === "string" ? siteId : "";
  const site = safeSiteId ? data.getSite(safeSiteId) : undefined;
  const entries = safeSiteId ? data.getSiteEntries(safeSiteId) : [];
  const [selectedItem, setSelectedItem] = useState<GalleryItem | null>(null);
  const [busy, setBusy] = useState<"export-all" | string | null>(null);
  const [photoStatuses, setPhotoStatuses] = useState<Record<string, EvidenceImageStatus>>({});
  const handlePhotoStatus = useCallback((status: EvidenceImageStatus, photoId: string) => {
    setPhotoStatuses((prev) => (prev[photoId] === status ? prev : { ...prev, [photoId]: status }));
  }, []);

  const galleryItems = useMemo<GalleryItem[]>(() => {
    return entries.flatMap((entry) =>
      entry.photos.map((photo) => ({
        id: `${entry.id}-${photo.id}`,
        siteName: site?.name || "Site",
        entryDate: entry.date,
        timestamp: photo.timestamp || entry.timestamp,
        notes: entry.notes || "",
        photo,
      }))
    ).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [entries, site?.name]);

  if (!site) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Site not found</Text>
      </View>
    );
  }

  // Settled failures only; a tile still loading is not yet a failure.
  const unavailableCount = galleryItems.filter(
    (item) => photoStatuses[item.photo.id] === "unavailable"
  ).length;

  const exportAll = async () => {
    if (galleryItems.length === 0) {
      Alert.alert("No photos", "There are no photos to export.");
      return;
    }
    // Previously this embedded ONLY photo.base64 and emitted an empty string for
    // anything else — a synced photo produced a card with no image and no note
    // that one was missing, while the meta still counted it. Every image is
    // resolved to a data uri up front, and a photo that cannot be resolved is
    // declared.
    let exportPhotos;
    setBusy("export-all");
    try {
      exportPhotos = await resolvePhotosForExport(galleryItems.map((item) => item.photo));
    } catch {
      Alert.alert(
        "Export Failed",
        "The photos could not be prepared for export. Check your connection and try again."
      );
      return;
    } finally {
      setBusy(null);
    }
    const notIncluded = exportPhotos.filter((photo) => !photo.exportDataUri).length;

    const cards = galleryItems
      .map((item, index) => {
        const imageMarkup = buildExportImageMarkup(exportPhotos[index], 260);
        return `
          <section class="section">
            <h2>Photo ${index + 1}</h2>
            ${imageMarkup}
            <table class="detail-table">
              <tr><th>Captured</th><td>${new Date(item.timestamp).toLocaleString("en-AU")}</td></tr>
              <tr><th>Entry Date</th><td>${item.entryDate}</td></tr>
              <tr><th>Caption</th><td>${item.photo.caption || "Not recorded"}</td></tr>
              <tr><th>Entry Notes</th><td>${item.notes || "Not recorded"}</td></tr>
            </table>
          </section>
        `;
      })
      .join("");

    const html = buildHtmlDocument({
      eyebrow: "Photo Gallery",
      title: `${site.name} Gallery`,
      subtitle: `${site.client} • ${galleryItems.length} photos`,
      meta: [
        { label: "Photos", value: formatPhotoCountForExport(galleryItems.length, notIncluded) },
        { label: "Site", value: site.name },
        { label: "Client", value: site.client },
      ],
      body: buildIncompleteRecordNotice(notIncluded, galleryItems.length) + cards,
    });

    const prompt =
      notIncluded > 0
        ? `${notIncluded} of ${galleryItems.length} images could not be attached and are marked "IMAGE NOT INCLUDED" in the document. Choose an export format.`
        : "Choose an export format.";
    Alert.alert("Export Gallery", prompt, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Word",
        onPress: () =>
          void runReportExport({
            filenameBase: `sitesnap-gallery-${site.name}-${new Date().toISOString().slice(0, 10)}`,
            html,
            format: "doc",
            label: "the photo gallery",
          }),
      },
      {
        text: "PDF",
        onPress: () =>
          void runReportExport({
            filenameBase: `sitesnap-gallery-${site.name}-${new Date().toISOString().slice(0, 10)}`,
            html,
            format: "pdf",
            label: "the photo gallery",
          }),
      },
    ]);
  };

  /**
   * Shares the image itself. This used to share `item.photo.uri` — for a synced
   * photo that is a signed proxy URL which expires in two hours, so the
   * recipient got a link that stops working, and the signature travelled with
   * it. The file is written to the cache and shared instead.
   */
  const exportSingle = async (item: GalleryItem) => {
    setBusy(item.id);
    try {
      const uri = await writeSharablePhotoFile(
        item.photo,
        `${site.name}-${item.entryDate}-photo`
      );
      if (!uri) {
        Alert.alert(
          "Photo Not Available",
          "This image could not be loaded, so there is nothing to share. Reopen the app while online and try again."
        );
        return;
      }
      await sharePhotoFile(uri, item.photo.mimeType || "image/jpeg");
    } catch (err) {
      console.warn("Export single photo failed", err);
      Alert.alert("Export Failed", "Could not export this photo.");
    } finally {
      setBusy(null);
    }
  };

  const openPreview = (item: GalleryItem) => {
    setSelectedItem(item);
  };

  return (
    <View style={styles.container}>
      <ScreenHeader
        variant="navy"
        title="Diary Gallery"
        subtitle={`${site.name} • ${galleryItems.length} photos`}
        backGlyph="arrow-back"
        backSize={20}
        gap={10}
        backButtonStyle={styles.headerIcon}
        titleStyle={styles.headerTitle}
        subtitleStyle={styles.headerSubtitle}
        right={
          <Pressable
            style={styles.headerIcon}
            onPress={() => void exportAll()}
            disabled={busy !== null}
          >
            {busy === "export-all" ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Ionicons name="download-outline" size={20} color={Colors.white} />
            )}
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {galleryItems.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="images-outline" size={44} color={Colors.textTertiary} />
            <Text style={styles.emptyTitle}>No project photos yet</Text>
            <Text style={styles.emptyText}>Add photos to entries, then they will appear here.</Text>
          </View>
        ) : (
          <>
            {unavailableCount > 0 && (
              <View style={styles.galleryWarning}>
                <Ionicons name="alert-circle" size={16} color={Colors.warningText} />
                <Text style={styles.galleryWarningText}>
                  {unavailableCount} of {galleryItems.length}{" "}
                  {galleryItems.length === 1 ? "photo" : "photos"} cannot be displayed. They are
                  marked below, and are flagged as not included in any export.
                </Text>
              </View>
            )}
            {galleryItems.map((item) => (
            <View key={item.id} style={styles.card}>
              <Pressable onPress={() => openPreview(item)}>
                <EvidenceImage
                  photo={item.photo}
                  style={styles.photo}
                  variant="thumb"
                  onStatusChange={handlePhotoStatus}
                />
              </Pressable>
              <View style={styles.cardBody}>
                <Text style={styles.cardDate}>
                  {new Date(item.timestamp).toLocaleDateString("en-AU", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
                <Text style={styles.cardMeta}>Entry Date: {item.entryDate}</Text>
                {!!item.photo.caption && <Text style={styles.cardCaption}>Caption: {item.photo.caption}</Text>}
                <Text style={styles.cardHint}>Open photo to pinch, zoom, and move around.</Text>
                <Pressable
                  style={styles.exportButton}
                  onPress={() => void exportSingle(item)}
                  disabled={busy !== null}
                >
                  {busy === item.id ? (
                    <ActivityIndicator size="small" color={Colors.accent} />
                  ) : (
                    <Ionicons name="share-outline" size={16} color={Colors.accent} />
                  )}
                  <Text style={styles.exportButtonText}>
                    {busy === item.id ? "Preparing…" : "Export Photo"}
                  </Text>
                </Pressable>
              </View>
            </View>
            ))}
          </>
        )}
      </ScrollView>

      <Modal visible={!!selectedItem} transparent animationType="fade" onRequestClose={() => setSelectedItem(null)}>
        <View style={styles.previewBackdrop}>
          <View style={styles.previewHeader}>
            <Pressable style={styles.previewIcon} onPress={() => setSelectedItem(null)}>
              <Ionicons name="close" size={20} color={Colors.white} />
            </Pressable>
            <Text style={styles.previewHint}>Pinch to zoom. Drag to move.</Text>
          </View>
          <View style={styles.previewCanvas}>
            {!!selectedItem && (
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
                  photo={selectedItem.photo}
                  style={styles.previewImage}
                  resizeMode="contain"
                  variant="full"
                  tone="dark"
                />
              </ScrollView>
            )}
          </View>
          {!!selectedItem && (
            <View style={styles.previewFooter}>
              <Text style={styles.previewDate}>{new Date(selectedItem.timestamp).toLocaleString("en-AU")}</Text>
              {!!selectedItem.photo.caption && <Text style={styles.previewCaption}>{selectedItem.photo.caption}</Text>}
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  notFound: { flex: 1, alignItems: "center", justifyContent: "center" },
  notFoundText: { color: Colors.text, fontSize: 16, fontFamily: "Inter_600SemiBold" },
  headerIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 18, color: Colors.white, fontFamily: "Inter_700Bold", fontWeight: undefined },
  headerSubtitle: { fontSize: 12, color: Colors.white, opacity: 0.9, fontFamily: "Inter_400Regular", marginTop: 0 },
  content: { padding: 16, gap: 12, paddingBottom: 30 },
  emptyState: { paddingVertical: 40, alignItems: "center", gap: 8 },
  emptyTitle: { fontSize: 16, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  emptyText: { fontSize: 13, color: Colors.textSecondary, fontFamily: "Inter_400Regular" },
  card: {
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  photo: {
    width: "100%",
    height: 220,
    backgroundColor: Colors.borderLight,
  },
  galleryWarning: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.warningBorder,
    backgroundColor: Colors.warningBg,
  },
  galleryWarningText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: "Inter_500Medium",
    color: Colors.warningText,
  },
  cardBody: { padding: 12, gap: 4 },
  cardDate: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  cardMeta: { fontSize: 12, color: Colors.textSecondary, fontFamily: "Inter_400Regular" },
  cardCaption: { fontSize: 12, color: Colors.textSecondary, fontFamily: "Inter_400Regular" },
  cardHint: { fontSize: 12, color: Colors.textTertiary, fontFamily: "Inter_400Regular", marginTop: 2 },
  exportButton: {
    marginTop: 8,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    backgroundColor: Colors.accent + "10",
  },
  exportButtonText: { fontSize: 13, color: Colors.accent, fontFamily: "Inter_600SemiBold" },
  previewBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.94)",
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  previewIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  previewHint: {
    color: Colors.white,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    opacity: 0.8,
  },
  previewCanvas: {
    flex: 1,
  },
  previewScroll: {
    flex: 1,
  },
  previewScrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  previewImage: {
    width: 360,
    height: 560,
    maxWidth: "100%",
  },
  previewFooter: {
    paddingTop: 14,
    gap: 6,
  },
  previewDate: {
    color: Colors.white,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  previewCaption: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
});
