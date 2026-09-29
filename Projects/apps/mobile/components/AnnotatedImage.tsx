import React from "react";
import { View, StyleSheet } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Photo } from "@/lib/types";
import { EvidenceImage, type EvidenceImageStatus } from "@/components/EvidenceImage";

type AnnotatedImageProps = {
  photo: Photo;
  width?: number;
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
 * The strokes are hidden while the photo is unavailable: annotations floating
 * over a warning box would suggest the markup applies to something the reader
 * can see, and it does not.
 */
export function AnnotatedImage({ photo, width }: AnnotatedImageProps) {
  const [status, setStatus] = React.useState<EvidenceImageStatus>("loading");
  const vector = photo.kind === "annotated" ? photo.annotationVector : undefined;
  const sizeStyle = width ? { width, height: width } : styles.fill;

  const handleStatus = React.useCallback((next: EvidenceImageStatus) => setStatus(next), []);

  return (
    <View style={[styles.wrap, sizeStyle]}>
      <EvidenceImage photo={photo} style={styles.fill} onStatusChange={handleStatus} />
      {vector && status === "displayable" && (
        <Svg width="100%" height="100%" viewBox={vector.viewBox} style={StyleSheet.absoluteFillObject}>
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
