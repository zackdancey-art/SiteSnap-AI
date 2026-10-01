import React from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import type { Photo } from "@/lib/types";
import {
  describeUnavailable,
  resolvePhotoSource,
  UNAVAILABLE_SHORT_LABEL,
  type PhotoUnavailableReason,
} from "@/lib/photo-uri";
import { reportMediaFailure } from "@/lib/media-telemetry";

/**
 * The only component that renders site-evidence imagery.
 *
 * THE RULE IT EXISTS TO ENFORCE
 *
 * A photo tile must never look like an ordinary placeholder when the image
 * behind it cannot be shown. Every photo surface in this app used a bare
 * `<Image source={{ uri: photo.uri }} />` with no onError, inside a container
 * with a `backgroundColor`. When the load failed — which it did, for six real
 * photographs, because the uri was an unsigned relative path — the container's
 * own grey showed through and the screen read as "loading" forever. A record
 * that silently understates what it holds is the worst failure mode this
 * product has: the photos were safe in S3 the whole time, and the app said
 * nothing.
 *
 * So there are exactly three visual states and they are unmistakable from one
 * another:
 *
 *   loading      a spinner, on the neutral tile background
 *   displayable  the image
 *   unavailable  an amber, dashed-bordered box with a warning glyph and words
 *
 * `unavailable` is deliberately not a prettier grey square. It is meant to be
 * noticed — by the person on site, and by whoever reads the record later.
 *
 * Failure is reported up via onStatusChange so a screen can also state the
 * partial failure once, at the top ("2 of 6 images unavailable"), rather than
 * leaving the reader to count boxes.
 */

export type EvidenceImageStatus = "loading" | "displayable" | "unavailable";

type EvidenceImageProps = {
  photo: Photo;
  /** The outer box. Give it the size; this component fills it. */
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  resizeMode?: "cover" | "contain";
  /** `thumb` shows a glyph and two words; `full` shows a sentence. */
  variant?: "thumb" | "full";
  /** `dark` for the full-screen preview, which sits on near-black. */
  tone?: "light" | "dark";
  onStatusChange?: (status: EvidenceImageStatus, photoId: string) => void;
};

export function EvidenceImage({
  photo,
  style,
  imageStyle,
  resizeMode = "cover",
  variant = "thumb",
  tone = "light",
  onStatusChange,
}: EvidenceImageProps) {
  const resolved = resolvePhotoSource(photo);
  const sourceUri = resolved.status === "displayable" ? resolved.uri : null;

  // `load-failed` is the runtime answer the pure resolver cannot give: the uri
  // was well-formed and loadable in principle, and the loader still rejected it.
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  // A new uri is a new attempt. Without this reset, one failure would stick to
  // the tile for the life of the component even after re-signing fixed it.
  React.useEffect(() => {
    setLoadFailed(false);
    setLoaded(false);
  }, [sourceUri]);

  const status: EvidenceImageStatus =
    resolved.status === "unavailable" || loadFailed
      ? "unavailable"
      : loaded
        ? "displayable"
        : "loading";

  React.useEffect(() => {
    onStatusChange?.(status, photo.id);
  }, [status, photo.id, onStatusChange]);

  if (resolved.status === "unavailable" || loadFailed || !sourceUri) {
    const reason: PhotoUnavailableReason =
      resolved.status === "unavailable" ? resolved.reason : "load-failed";
    return (
      <View style={[styles.box, styles.unavailable, tone === "dark" && styles.unavailableDark, style]}>
        <Ionicons
          name="alert-circle"
          size={variant === "thumb" ? 20 : 34}
          color={tone === "dark" ? Colors.warningBorder : Colors.warningText}
        />
        <Text
          style={[
            variant === "thumb" ? styles.unavailableTextThumb : styles.unavailableTextFull,
            tone === "dark" && styles.unavailableTextDark,
          ]}
          numberOfLines={variant === "thumb" ? 2 : 4}
        >
          {variant === "thumb" ? UNAVAILABLE_SHORT_LABEL : describeUnavailable(reason)}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.box, style]}>
      <Image
        source={{ uri: sourceUri }}
        style={[styles.image, imageStyle]}
        resizeMode={resizeMode}
        onLoad={() => setLoaded(true)}
        onError={(event) => {
          setLoadFailed(true);
          // The failure this whole component exists because of. <Image> reports
          // it here and nowhere else — no throw, no log — so if this does not
          // report it, nothing does.
          reportMediaFailure({
            kind: "image-load-failed",
            uri: sourceUri,
            reason: event?.nativeEvent?.error ? String(event.nativeEvent.error) : undefined,
          });
        }}
      />
      {!loaded && (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="small" color={tone === "dark" ? Colors.white : Colors.accent} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: "relative",
    overflow: "hidden",
    backgroundColor: Colors.borderLight,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  // Amber, dashed, glyphed. Nothing in this app's normal chrome looks like
  // this, which is the point — it cannot be mistaken for a photo that is still
  // arriving, and it cannot be mistaken for a photo.
  unavailable: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: 6,
    backgroundColor: Colors.warningBg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.warningBorder,
  },
  unavailableDark: {
    backgroundColor: "rgba(245, 158, 11, 0.14)",
  },
  unavailableTextThumb: {
    fontSize: 9,
    lineHeight: 11,
    textAlign: "center",
    fontFamily: "Inter_600SemiBold",
    color: Colors.warningText,
  },
  unavailableTextFull: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    paddingHorizontal: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.warningText,
  },
  unavailableTextDark: {
    color: Colors.warningBorder,
  },
});
