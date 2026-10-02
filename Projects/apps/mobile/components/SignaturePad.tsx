import React, { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import Colors from "@/constants/colors";

// Dev-only layout probe. The require is deliberately INSIDE `if (__DEV__)`: a
// top-level import of this module ships its code in production bundles, a gated
// require eliminates it entirely. Both measured by grepping a production Hermes
// bundle — see the header of lib/dev-signature-probe.ts. Do not convert this to
// an import.
let DevProbe: typeof import("@/lib/dev-signature-probe") | null = null;
if (__DEV__) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DevProbe = require("@/lib/dev-signature-probe");
}

type SignaturePadProps = {
  onChange: (path: string) => void;
  viewBox: string;
  height?: number;
};

function parseViewBox(viewBox: string): { width: number; height: number } {
  const parts = viewBox.trim().split(/\s+/).map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2] > 0 && parts[3] > 0) {
    return { width: parts[2], height: parts[3] };
  }
  return { width: 320, height: 160 };
}

/**
 * Offline vector signature capture. Accumulates pan strokes into a single SVG
 * path string (each new touch starts a fresh "M x y" segment; lifting and
 * touching again keeps appending to the same path) scaled into the caller's
 * viewBox coordinate space so the stored path is stable regardless of the
 * device's actual render width.
 */
export function SignaturePad({ onChange, viewBox, height }: SignaturePadProps) {
  const { width: vbWidth, height: vbHeight } = useMemo(() => parseViewBox(viewBox), [viewBox]);
  const surfaceHeight = height ?? vbHeight;

  const [layoutWidth, setLayoutWidth] = useState(vbWidth);
  const scaleX = layoutWidth > 0 ? vbWidth / layoutWidth : 1;
  const scaleY = surfaceHeight > 0 ? vbHeight / surfaceHeight : 1;
  const scaleRef = useRef({ x: scaleX, y: scaleY });
  scaleRef.current = { x: scaleX, y: scaleY };

  const [path, setPath] = useState("");
  const pathRef = useRef("");

  const handleLayout = (e: LayoutChangeEvent) => {
    setLayoutWidth(e.nativeEvent.layout.width);
  };

  const appendPoint = useCallback((cmd: "M" | "L", x: number, y: number) => {
    const { x: sx, y: sy } = scaleRef.current;
    const vx = Math.round(x * sx * 10) / 10;
    const vy = Math.round(y * sy * 10) / 10;
    pathRef.current = pathRef.current ? `${pathRef.current} ${cmd} ${vx} ${vy}` : `${cmd} ${vx} ${vy}`;
    setPath(pathRef.current);
    onChange(pathRef.current);
  }, [onChange]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onBegin((e) => {
          runOnJS(appendPoint)("M", e.x, e.y);
        })
        .onUpdate((e) => {
          runOnJS(appendPoint)("L", e.x, e.y);
        }),
    [appendPoint]
  );

  const handleClear = () => {
    pathRef.current = "";
    setPath("");
    onChange("");
  };

  const hasStrokes = path.length > 0;

  return (
    <View style={styles.wrap} ref={DevProbe ? DevProbe.nodeRef("padWrap") : undefined}>
      {/* Clear sits ABOVE the canvas. It used to render after it, 8pt below the
          signing surface and right-aligned, which put a tappable control
          immediately under the area being signed — close enough to be read as one
          of the sheet's own buttons. Above the canvas it is unambiguous, and the
          space under the canvas now belongs to Cancel/Save alone. */}
      <View style={styles.toolbar}>
        <Pressable style={styles.clearBtn} onPress={handleClear} hitSlop={8} disabled={!hasStrokes}>
          <Text style={[styles.clearBtnText, !hasStrokes && styles.clearBtnTextDisabled]}>Clear</Text>
        </Pressable>
      </View>
      {/* This style exists to DISPLACE the library's own default, and must not
          be deleted as redundant. GestureHandlerRootView renders
          `<View style={style ?? styles.container} />` with its container being
          `{ flex: 1 }` (react-native-gesture-handler 2.28.0,
          src/components/GestureHandlerRootView.tsx), so omitting `style` is NOT
          the same as not flexing — it applies the library's flex:1 instead.

          Why flex:1 is wrong here: in React Native, `flex: 1` with no explicit
          `flexBasis` resolves flexBasis to ZERO points, not to `auto` as on the
          web (react-native/ReactCommon/yoga/yoga/node/Node.cpp:334-336 —
          processFlexBasis() returns points(0) unless useWebDefaults()). A
          flexBasis-0 child of an auto-height parent contributes 0 to that
          parent's content height, and flexGrow has no free space to claim, so
          this view measured 0pt tall. Its 160pt canvas still painted (overflow
          defaults to visible) but occupied no layout space, so the Cancel/Save
          row below was positioned against a 0pt box and drew on top of the
          signing surface, and the canvas ran off the bottom of the screen.
          See AUDIT L27. */}
      <GestureHandlerRootView style={styles.padRoot}>
        <GestureDetector gesture={pan}>
          <View
            style={[styles.surface, { height: surfaceHeight }]}
            onLayout={handleLayout}
            ref={DevProbe ? DevProbe.nodeRef("canvas") : undefined}
          >
            <Svg width="100%" height="100%" viewBox={viewBox}>
              <Path
                d={`M0 ${vbHeight - 16} L${vbWidth} ${vbHeight - 16}`}
                stroke={Colors.borderLight}
                strokeWidth={1}
              />
              {hasStrokes && (
                <Path d={path} stroke={Colors.text} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </Svg>
            {!hasStrokes && (
              <Text style={styles.hint} pointerEvents="none">Sign above</Text>
            )}
          </View>
        </GestureDetector>
      </GestureHandlerRootView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  // Sizes to its content (the canvas's explicit height). See the comment at
  // the usage site — this is here to override the library's flex:1 default.
  padRoot: { flexGrow: 0, flexBasis: "auto" },
  surface: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    backgroundColor: Colors.background,
    overflow: "hidden",
  },
  hint: {
    position: "absolute",
    bottom: 10,
    left: 0,
    right: 0,
    textAlign: "center",
    fontSize: 12,
    color: Colors.textTertiary,
  },
  toolbar: { flexDirection: "row", justifyContent: "flex-end" },
  clearBtn: { paddingHorizontal: 12, paddingVertical: 6 },
  clearBtnText: { fontSize: 13, fontWeight: "700", color: Colors.accent },
  clearBtnTextDisabled: { color: Colors.textTertiary },
});
