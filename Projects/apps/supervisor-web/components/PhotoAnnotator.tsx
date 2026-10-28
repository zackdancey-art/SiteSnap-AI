"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  annotationViewBox,
  ANNOTATION_PALETTE,
  ANNOTATION_STROKE_WIDTH,
  buildArrowPath,
  buildBoxPath,
  buildLinePath,
  DEFAULT_ANNOTATION_COLOUR,
  type AnnotationStroke,
  type AnnotationVector,
} from "@/lib/annotation-derivative";

/**
 * Draw on a site photograph, in the portal.
 *
 * WHAT THIS DOES NOT DO, AND WHY
 *
 * It does not touch the photograph. Saving produces an `AnnotationVector` — a
 * viewBox and a list of SVG path strokes — which the caller stores on a NEW
 * photograph record beside the original (see lib/annotation-derivative.ts).
 * Nothing here reads, rasterises or re-uploads pixels, which is also why the
 * `Cross-Origin-Resource-Policy: same-site` scope on the media route did not
 * have to be widened: a `<canvas>` rasterisation would need the image loaded
 * with `crossorigin="anonymous"` to avoid tainting, and that is a CORP change.
 *
 * NO FREEHAND, NO TEXT — both deliberate, for different reasons.
 *
 * Freehand is mobile's tool, and a finger is good at it; a mouse is not, and a
 * trackpad is worse. The three shapes here are the ones a pointer draws well.
 * They produce the same `{path, color, width}` strokes mobile produces, so
 * mobile renders portal annotations with no change at all.
 *
 * Text is absent because it is NOT REPRESENTABLE. `AnnotationStroke` is
 * `{path, color, width}` and apps/mobile/components/AnnotatedImage.tsx renders
 * strokes as `<Path … fill="none">` and nothing else. A text label stored from
 * here would sync, and then be invisible on the phone — the two surfaces
 * disagreeing about what is marked on a piece of compliance evidence, which is
 * the exact failure this workstream exists to prevent. Adding it needs an
 * additive change to the vector type AND a matching mobile renderer, shipped
 * together; it is flagged in the PR body, not half-built here.
 *
 * NOT VERIFIED IN A BROWSER: this environment has no browser and no Playwright.
 * The pointer-to-viewBox arithmetic below is reasoned against mobile's
 * `handleImageLayout`, and `annotationViewBox` is unit-tested, but the drag
 * behaviour itself has not been observed.
 */

type Tool = "line" | "arrow" | "box";

const TOOLS: { tool: Tool; label: string; hint: string }[] = [
  { tool: "line", label: "Line", hint: "Drag to draw a line" },
  { tool: "arrow", label: "Arrow", hint: "Drag from the tail to what it points at" },
  { tool: "box", label: "Box", hint: "Drag across to box an area" },
];

/** A drag in progress, in viewBox coordinates. */
type Draft = { x1: number; y1: number; x2: number; y2: number };

function draftPath(tool: Tool, d: Draft): string {
  if (tool === "box") return buildBoxPath(d.x1, d.y1, d.x2, d.y2);
  if (tool === "arrow") return buildArrowPath(d.x1, d.y1, d.x2, d.y2);
  return buildLinePath(d.x1, d.y1, d.x2, d.y2);
}

export default function PhotoAnnotator({
  src, alt, caption, saving, error, onSave, onCancel,
}: {
  src: string;
  alt: string;
  caption?: string;
  saving?: boolean;
  /** A failed save, shown here so the drawing is not lost to a disappearing dialog. */
  error?: string | null;
  onSave: (vector: AnnotationVector) => void;
  onCancel: () => void;
}) {
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState(DEFAULT_ANNOTATION_COLOUR);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  /**
   * The displayed size of the image, in CSS pixels.
   *
   * Held in state rather than read on demand because the viewBox depends on it
   * and the overlay has to re-render when it changes — a window resize while
   * the annotator is open would otherwise leave the overlay sized to the old
   * box and every subsequent stroke misplaced.
   */
  const [box, setBox] = useState({ width: 0, height: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragging = useRef(false);

  const measure = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setBox({ width: rect.width, height: rect.height });
  }, []);

  // Measured on load AND on resize. `object-fit: contain` means the rendered box
  // is not the element box, so this reads the element's own rect after layout.
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Escape cancels, as it does in the viewer this opens from. Deliberately NOT
  // bound to Enter: an accidental Enter writing a record to a compliance diary
  // is worse than making the person click Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const space = annotationViewBox(box.width, box.height);

  /** Pointer position in viewBox coordinates, clamped to the image. */
  const toViewBox = (e: React.PointerEvent): { x: number; y: number } | null => {
    const el = imgRef.current;
    if (!el || !space) return null;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) * space.scaleX;
    const y = (e.clientY - rect.top) * space.scaleY;
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const at = toViewBox(e);
    if (!at) return;
    // Capture so a drag that leaves the image still ends properly. Without it a
    // pointerup outside the element never arrives and the draft stays stuck to
    // the cursor.
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragging.current = true;
    setDraft({ x1: at.x, y1: at.y, x2: at.x, y2: at.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const at = toViewBox(e);
    if (!at) return;
    setDraft((d) => (d ? { ...d, x2: at.x, y2: at.y } : d));
  };

  const onPointerUp = () => {
    dragging.current = false;
    setDraft((d) => {
      if (!d) return null;
      // A click with no drag is not a shape. Committing one would store a
      // zero-length stroke that renders as nothing and still counts as an
      // annotation, so the record would claim a drawing that is not there.
      const moved = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= 4;
      if (moved) {
        setStrokes((prev) => [
          ...prev,
          { path: draftPath(tool, d), color, width: ANNOTATION_STROKE_WIDTH },
        ]);
      }
      return null;
    });
  };

  const canSave = strokes.length > 0 && !!space && !saving;

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "6px 12px", fontSize: 13, borderRadius: 6, cursor: "pointer",
    border: active ? "1px solid #fff" : "1px solid rgba(255,255,255,0.25)",
    background: active ? "rgba(255,255,255,0.18)" : "transparent",
    color: "#fff", fontWeight: active ? 600 : 400,
  });

  const activeHint = TOOLS.find((t) => t.tool === tool)?.hint ?? "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Annotate photograph"
      style={{
        position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.94)",
        display: "flex", flexDirection: "column",
      }}
    >
      {/* ── tools ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.12)",
      }}>
        {TOOLS.map((t) => (
          <button key={t.tool} onClick={() => setTool(t.tool)} style={chip(tool === t.tool)} title={t.hint}>
            {t.label}
          </button>
        ))}

        <span style={{ width: 1, height: 22, background: "rgba(255,255,255,0.18)", margin: "0 4px" }} />

        {ANNOTATION_PALETTE.map((c) => (
          <button
            key={c.color}
            onClick={() => setColor(c.color)}
            aria-label={c.label}
            title={c.label}
            style={{
              width: 24, height: 24, borderRadius: "50%", background: c.color, cursor: "pointer",
              // The selected swatch is a ring, not a tick: a tick in a
              // contrasting colour over #1E3A8A is itself hard to see.
              border: color === c.color ? "2px solid #fff" : "2px solid rgba(255,255,255,0.25)",
              boxShadow: color === c.color ? "0 0 0 2px rgba(0,0,0,0.6)" : "none",
            }}
          />
        ))}

        <span style={{ flex: 1 }} />

        <button
          onClick={() => setStrokes((s) => s.slice(0, -1))}
          disabled={strokes.length === 0}
          style={{ ...chip(false), opacity: strokes.length === 0 ? 0.35 : 1, cursor: strokes.length === 0 ? "default" : "pointer" }}
        >
          Undo
        </button>
        <button
          onClick={() => setStrokes([])}
          disabled={strokes.length === 0}
          style={{ ...chip(false), opacity: strokes.length === 0 ? 0.35 : 1, cursor: strokes.length === 0 ? "default" : "pointer" }}
        >
          Clear
        </button>
      </div>

      {/* ── the photograph, with the drawing over it ── */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
        <div style={{ position: "relative", display: "inline-flex", maxWidth: "100%", maxHeight: "100%" }}>
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={measure}
            style={{
              maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
              display: "block", userSelect: "none", touchAction: "none",
            }}
          />
          {space && (
            <svg
              viewBox={space.viewBox}
              preserveAspectRatio="none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              style={{
                position: "absolute", inset: 0, width: "100%", height: "100%",
                cursor: "crosshair", touchAction: "none",
              }}
            >
              {strokes.map((s, i) => (
                <path
                  key={i} d={s.path} stroke={s.color} strokeWidth={s.width}
                  fill="none" strokeLinecap="round" strokeLinejoin="round"
                />
              ))}
              {draft && (
                <path
                  d={draftPath(tool, draft)} stroke={color} strokeWidth={ANNOTATION_STROKE_WIDTH}
                  fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.85}
                />
              )}
            </svg>
          )}
        </div>
      </div>

      {/* ── what happens on save, said plainly, and the way out ── */}
      <div style={{
        padding: "10px 14px", borderTop: "1px solid rgba(255,255,255,0.12)",
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      }}>
        <div style={{ flex: 1, minWidth: 200, fontSize: 12, color: "rgba(255,255,255,0.65)", lineHeight: 1.5 }}>
          {caption ? <div style={{ color: "#fff", fontSize: 13, marginBottom: 2 }}>{caption}</div> : null}
          {/* Said before the click, not after: the person is marking up
              compliance evidence and is entitled to know the original stays. */}
          <div>Saving adds a marked-up copy. The original photograph is kept.</div>
          <div style={{ opacity: 0.75 }}>{activeHint}.</div>
          {error ? (
            <div role="alert" style={{ color: "#FCA5A5", marginTop: 4 }}>
              {error} Your drawing is still here — try Save again.
            </div>
          ) : null}
        </div>
        <button onClick={onCancel} style={chip(false)} disabled={saving}>Cancel</button>
        <button
          onClick={() => { if (space && strokes.length) onSave({ viewBox: space.viewBox, strokes }); }}
          disabled={!canSave}
          style={{
            ...chip(true), fontWeight: 600,
            opacity: canSave ? 1 : 0.4, cursor: canSave ? "pointer" : "default",
          }}
        >
          {saving ? "Saving…" : "Save annotation"}
        </button>
      </div>
    </div>
  );
}
