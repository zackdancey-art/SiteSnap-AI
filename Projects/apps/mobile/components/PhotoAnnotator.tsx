import React, { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Image, LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { AnnotationStroke, AnnotationVector, Photo } from "@/lib/types";
import { describeUnavailable, resolvePhotoSource } from "@/lib/photo-uri";

type PhotoAnnotatorProps = {
  photo: Photo;
  onSave: (vector: AnnotationVector) => void;
  onCancel: () => void;
};

const VIEWBOX_WIDTH = 1000;
const STROKE_WIDTH = 6;

const PALETTE = [
  { label: "Red", color: "#EF4444" },
  { label: "Amber", color: "#F59E0B" },
  { label: "Navy", color: Colors.primary },
];

export function PhotoAnnotator({ photo, onSave, onCancel }: PhotoAnnotatorProps) {
  /**
   * This picked `photo.uri` whenever it was set, even when it was a bare
   * /api/uploads/... path that React Native cannot load — the result was an empty
   * canvas you could still draw on, producing strokes whose coordinates mean
   * nothing against a photo nobody saw. Annotation is refused outright when the
   * image cannot be shown.
   *
   * This component is not built on EvidenceImage because it needs the image's own
   * onLayout to derive the SVG viewBox scale.
   */
  const resolved = resolvePhotoSource(photo);
  const canAnnotate = resolved.status === "displayable";
  const source = resolved.status === "displayable" ? { uri: resolved.uri } : undefined;

  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 });
  const [vbHeight, setVbHeight] = useState(VIEWBOX_WIDTH);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const strokesRef = useRef<AnnotationStroke[]>([]);
  const [color, setColor] = useState(Colors.accent);

  const scaleRef = useRef({ x: 1, y: 1 });

  const handleImageLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    setBoxSize({ width, height });
    const nextVbHeight = Math.round((VIEWBOX_WIDTH / width) * height);
    setVbHeight(nextVbHeight);
    scaleRef.current = { x: VIEWBOX_WIDTH / width, y: nextVbHeight / height };
  };

  const appendPoint = useCallback((cmd: "M" | "L", x: number, y: number) => {
    const { x: sx, y: sy } = scaleRef.current;
    const vx = Math.round(x * sx * 10) / 10;
    const vy = Math.round(y * sy * 10) / 10;
    const current = strokesRef.current;
    const last = current[current.length - 1];
    if (!last) return;
    const nextLast: AnnotationStroke = {
      ...last,
      path: last.path ? `${last.path} ${cmd} ${vx} ${vy}` : `${cmd} ${vx} ${vy}`,
    };
    const next = [...current.slice(0, -1), nextLast];
    strokesRef.current = next;
    setStrokes(next);
  }, []);

  const beginStroke = useCallback((x: number, y: number) => {
    const next = [...strokesRef.current, { path: "", color, width: STROKE_WIDTH }];
    strokesRef.current = next;
    setStrokes(next);
    appendPoint("M", x, y);
  }, [appendPoint, color]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(canAnnotate)
        .minDistance(0)
        .onBegin((e) => {
          runOnJS(beginStroke)(e.x, e.y);
        })
        .onUpdate((e) => {
          runOnJS(appendPoint)("L", e.x, e.y);
        }),
    [beginStroke, appendPoint, canAnnotate]
  );

  const handleUndo = () => {
    const next = strokesRef.current.slice(0, -1);
    strokesRef.current = next;
    setStrokes(next);
  };

  const handleClear = () => {
    strokesRef.current = [];
    setStrokes([]);
  };

  const handleSave = () => {
    if (strokes.length === 0) return;
    onSave({ viewBox: `0 0 ${VIEWBOX_WIDTH} ${vbHeight}`, strokes });
  };

  const hasStrokes = strokes.length > 0 && canAnnotate;

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.title}>Annotate Photo</Text>
        <Pressable onPress={onCancel} hitSlop={8}>
          <Ionicons name="close" size={22} color={Colors.textSecondary} />
        </Pressable>
      </View>

      <GestureHandlerRootView style={{ flex: 1 }}>
        <GestureDetector gesture={pan}>
          <View style={styles.imageBox} onLayout={handleImageLayout}>
            {source ? (
              <Image source={source} style={StyleSheet.absoluteFillObject} resizeMode="contain" />
            ) : (
              <View style={styles.unavailable}>
                <Ionicons name="alert-circle" size={30} color={Colors.warningText} />
                <Text style={styles.unavailableTitle}>Cannot annotate this photo</Text>
                <Text style={styles.unavailableText}>
                  {describeUnavailable(
                    resolved.status === "unavailable" ? resolved.reason : "load-failed"
                  )}
                </Text>
              </View>
            )}
            {canAnnotate && boxSize.width > 0 && (
              <Svg
                width="100%"
                height="100%"
                viewBox={`0 0 ${VIEWBOX_WIDTH} ${vbHeight}`}
                style={StyleSheet.absoluteFillObject}
              >
                {strokes.map((s, i) => (
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
        </GestureDetector>
      </GestureHandlerRootView>

      <View style={styles.paletteRow}>
        {PALETTE.map((p) => (
          <Pressable
            key={p.color}
            style={[styles.swatch, { backgroundColor: p.color }, color === p.color && styles.swatchActive]}
            onPress={() => setColor(p.color)}
            hitSlop={6}
          />
        ))}
      </View>

      <View style={styles.actionsRow}>
        <Pressable style={styles.secondaryBtn} onPress={handleUndo} disabled={!hasStrokes}>
          <Text style={[styles.secondaryBtnText, !hasStrokes && styles.disabledText]}>Undo</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={handleClear} disabled={!hasStrokes}>
          <Text style={[styles.secondaryBtnText, !hasStrokes && styles.disabledText]}>Clear</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={onCancel}>
          <Text style={styles.secondaryBtnText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.saveBtn, !hasStrokes && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!hasStrokes}
        >
          <Ionicons name="checkmark" size={18} color={Colors.white} />
          <Text style={styles.saveBtnText}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: Colors.surface,
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  unavailable: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 24,
    backgroundColor: Colors.warningBg,
  },
  unavailableTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.warningText,
    textAlign: "center",
  },
  unavailableText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: "Inter_400Regular",
    color: Colors.warningText,
    textAlign: "center",
  },
  imageBox: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
    position: "relative",
  },
  paletteRow: {
    flexDirection: "row",
    gap: 12,
    alignSelf: "center",
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchActive: {
    borderColor: Colors.text,
  },
  actionsRow: {
    flexDirection: "row",
    gap: 10,
  },
  secondaryBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textSecondary,
  },
  disabledText: {
    opacity: 0.5,
  },
  saveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.accent,
  },
  saveBtnDisabled: {
    opacity: 0.5,
  },
  saveBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
});
