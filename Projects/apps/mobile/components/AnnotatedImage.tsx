import React from "react";
import { View, StyleSheet, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Photo } from "@/lib/types";
import { EvidenceImage, type EvidenceImageStatus } from "@/components/EvidenceImage";
import { selectAnnotationOverlay, overlayPreserveAspectRatio } from "@/lib/annotation-render";

type AnnotatedImageProps = {
  photo: Photo;
  /** Convenience for a square box. Prefer `style` where the box is not square. */
  width?: number;
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

/**
 * Presentational: renders a photo, and if it's an annotated derivative,
 * overlays its vector strokes scaled to the image box via the SVG viewBox.
 *
 * The image itself goes through EvidenceImage, so a photo that cannot be shown
 * says so instead of leaving an empty box. This component used to pick its own
 * source with `photo.uri ? {uri} : photo.base64 ? …`, which chose an unloadable
 * relative `/api/uploads/…` path over a perfectly good local payload; that
 * choice now lives in one place (lib/photo-uri.ts) and prefers the payload.
 *
 * THIS IS A STRICT SUPERSET OF `EvidenceImage` AND THAT IS THE POINT. It
 * forwards every one of that component's props untouched, so any photo surface
 * can use this instead with no other change and no loss — including
 * `onStatusChange`, which the screens use to say "2 of 6 images unavailable" at
 * the top. Before this, swapping a surface over meant giving that up, and the
 * cheapness of leaving `EvidenceImage` in place is how four of six surfaces
 * ended up unable to draw an annotation at all (AUDIT L119).
 *
 * WHICH strokes get drawn, WHETHER they get drawn, and HOW they are fitted are
 * not decided here — they are in `lib/annotation-render.ts`, which has no react
 * import and is therefore testable in an environment with no simulator. This
 * file is the mount and nothing else.
 */
export function AnnotatedImage({
  photo,
  width,
  style,
  imageStyle,
  resizeMode = "cover",
  variant = "thumb",
  tone = "light",
  onStatusChange,
}: AnnotatedImageProps) {
  const [status, setStatus] = React.useState<EvidenceImageStatus>("loading");
  const vector = selectAnnotationOverlay(photo, status);
  const sizeStyle = width ? { width, height: width } : styles.fill;

  // Chained rather than replaced: the overlay needs the status to know whether
  // the photograph is on screen, and the screen above needs it to count the
  // ones that are not. Dropping the caller's would silence the partial-failure
  // banner on every surface that moved to this component.
  const handleStatus = React.useCallback(
    (next: EvidenceImageStatus, photoId: string) => {
      setStatus(next);
      onStatusChange?.(next, photoId);
    },
    [onStatusChange]
  );

  return (
    <View style={[styles.wrap, sizeStyle, style]}>
      <EvidenceImage
        photo={photo}
        style={styles.fill}
        imageStyle={imageStyle}
        resizeMode={resizeMode}
        variant={variant}
        tone={tone}
        onStatusChange={handleStatus}
      />
      {vector && (
        <Svg
          width="100%"
          height="100%"
          viewBox={vector.viewBox}
          preserveAspectRatio={overlayPreserveAspectRatio(resizeMode)}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        >
          {vector.strokes.map((s, i) => (
            <Path
              key={i}
              d={s.path}
              stroke={s.color}
              strokeWidth={s.width}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    overflow: "hidden",
  },
  fill: {
    width: "100%",
    height: "100%",
  },
});
