"use client";

import { Fragment, useCallback, useEffect, useState, useMemo, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ProfileDropdown from "@/components/ProfileDropdown";
import { SkeletonTable } from "@/components/Skeleton";
import { siteStatusCfg } from "@/lib/siteStatus";
import {
  fetchBootstrap, getSavedUser, isAuthenticated,
  fetchTimecards, fetchIncidents, fetchInspections, fetchDeliveries,
  approveDiary, signUploadPaths, listClients, fileSiteUnderClient, setSiteJobNumber,
  setTimecardApproval, updateEntryPhotos,
} from "@/lib/api";
import type {
  BootstrapData, Client, Diary, Entry, EntryPhoto, User,
  Timecard, Incident, Inspection, Delivery,
} from "@/lib/api";
import { useRole, canApproveTimesheet } from "@/lib/useRole";
import {
  describeApprovalFailure,
  isTimecardEditable,
  normaliseApprovalStatus,
  TIMECARD_APPROVAL_STATUSES,
  TIMECARD_NOTE_MAX_LENGTH,
  type TimecardApprovalStatus,
} from "@/lib/timecard-approval";
import { describeCaptureTime } from "@/lib/photo-capture-time";
import { JOB_NUMBER_MAX_LENGTH, normaliseJobNumber } from "@/lib/job-number";
import {
  describePhotoAuthor, describePhotoDerivation, describePhotoPlace,
  describePhotoRecord, stepPhotoIndex,
} from "@/lib/photo-provenance";
import { buildViewerShots, buildViewerShotsForRecords } from "@/lib/photo-viewer-set";
import PhotoAnnotator from "@/components/PhotoAnnotator";
import { buildAnnotationDerivative, type AnnotationVector } from "@/lib/annotation-derivative";
import { selectAnnotationOverlay, overlayPreserveAspectRatio } from "@/lib/annotation-render";
import type { ViewerShot as LibViewerShot } from "@/lib/photo-viewer-set";

type Tab = "overview" | "entries" | "timesheets" | "incidents" | "inspections" | "dockets" | "photos" | "reports";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview",    label: "Overview",    icon: "🏗️" },
  { id: "entries",     label: "Entries",     icon: "📄" },
  { id: "timesheets",  label: "Timesheets",  icon: "⏱️" },
  { id: "incidents",   label: "Incidents",   icon: "⚠️" },
  { id: "inspections", label: "Inspections", icon: "🔍" },
  { id: "dockets",     label: "Dockets",     icon: "📦" },
  { id: "photos",      label: "Photos",      icon: "📷" },
  { id: "reports",     label: "Reports",     icon: "📋" },
];

/**
 * How many paths go in one `/api/uploads/sign` request.
 *
 * The server refuses more than 50 per request and returns 400 for the WHOLE
 * request — so a site with 51 photographs displayed none of them, and a site
 * with 49 displayed all of them. The photograph count decided whether the
 * feature existed (AUDIT L42).
 *
 * BATCHED, NOT VIEWPORT-DRIVEN, AND WHY
 *
 * Signing only what is on screen would save requests for photographs the
 * manager never scrolls to, but it does not make any individual photograph
 * cheaper: the cost is one indexed ownership lookup plus an HMAC per path
 * either way. What it does cost is an IntersectionObserver per tile, a request
 * queue fed from render, and the same machinery again for the Entries tab —
 * real complexity in an effect that has just been repaired for re-entrancy,
 * and the part most likely to reintroduce it.
 *
 * Batching is a slice on top of the structure already here. The first batch
 * displays immediately and the rest fill in behind it, so the count no longer
 * decides whether any photograph appears, which is what was asked for.
 *
 * The expense worth managing is not the signatures — a few hundred bytes of
 * JSON each — but the photographs, which are megabytes each. That is handled
 * where it belongs, with `loading="lazy"` on the images, so the bytes are not
 * fetched until a tile is near the viewport however many have been signed.
 *
 * 25 rather than 50: half the server's ceiling, so a batch cannot be pushed
 * over it by an off-by-one, and small enough that the first row of tiles
 * appears quickly on a site with hundreds.
 */
const SIGN_BATCH_SIZE = 25;

const SEVERITY_CFG: Record<string, { label: string; color: string; bg: string }> = {
  "near-miss": { label: "Near Miss", color: "#F59E0B", bg: "#FFFBEB" },
  minor:       { label: "Minor",     color: "#E8731A", bg: "#FFF7ED" },
  major:       { label: "Major",     color: "#EF4444", bg: "#FEF2F2" },
  critical:    { label: "Critical",  color: "#7C3AED", bg: "#F5F3FF" },
};

/**
 * How each approval state is drawn, and the words used for it.
 *
 * Shaped like SEVERITY_CFG above and drawn from the same hex pairs already used
 * on this page — the Open/Closed incident badges and the major-severity red — so
 * this adds a vocabulary, not a palette.
 *
 * It lives here rather than in `lib/timecard-approval.ts` for the same reason
 * SEVERITY_CFG lives here: the module next door holds the decisions, which are
 * the parts that can be reasoned about and, when the portal gets a test harness,
 * tested. Colours are rendering.
 *
 * "SENT BACK" RATHER THAN "REJECTED"
 *
 * The API's word is `rejected`, and the manager reading this screen is not the
 * only person who will: these are somebody's hours, and "rejected" reads as a
 * judgement of the worker rather than of a form that needs a correction. Mobile
 * uses the same two words on the same state for the same reason.
 *
 * Typed `Record<TimecardApprovalStatus, …>` and not `Record<string, …>` — unlike
 * SEVERITY_CFG, which needs a `?? SEVERITY_CFG.minor` fallback at every call
 * site because its key is an unvalidated string. Every read of this table goes
 * through `normaliseApprovalStatus` first, so the key is one of exactly three
 * values and a missing entry is a compile error rather than a blank badge.
 */
const APPROVAL_CFG: Record<TimecardApprovalStatus, { label: string; color: string; bg: string }> = {
  pending:  { label: "Pending",   color: "#CA8A04", bg: "#FEF9C3" },
  approved: { label: "Approved",  color: "#22C55E", bg: "#F0FDF4" },
  rejected: { label: "Sent back", color: "#EF4444", bg: "#FEF2F2" },
};

/**
 * The timesheet table's columns, as a list rather than as markup.
 *
 * The send-back note opens in a row of its own underneath the card it belongs
 * to, and that row needs a `colSpan` covering the whole table. Written as a
 * literal it would read correctly against the wrong number for the life of the
 * file — a column added later leaves the note box one cell short, which is a
 * silent layout break nothing reports. Rendering the header from this list means
 * the span is counted from the same place the columns come from.
 *
 * The Approval column is NOT in here: it is only drawn for a manager, so it is
 * added to the count where that is known rather than conditionally removed.
 */
const TIMECARD_COLUMNS = [
  "Date", "Worker", "Trade", "Start", "End", "Break", "Regular", "OT", "Notes", "Status",
] as const;

function formatTime(t?: string) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/**
 * One photograph together with the record it belongs to.
 *
 * The entry travels with the photograph because three of the four questions the
 * viewer has to answer cannot be answered from the image alone: the entry
 * supplies the work date, the stand-in address when the photograph carries no
 * coordinates of its own, and the account that logged it. The Photos tab
 * flattens every entry's photographs into one grid, so without this pairing a
 * photograph in that grid has no way back to its record.
 *
 * The shape and the two functions that build it live in `lib/photo-viewer-set.ts`
 * and are tested there. This is only the concrete instantiation for the portal's
 * own `EntryPhoto` and `Entry`.
 */
type ViewerShot = LibViewerShot<EntryPhoto, Entry>;

/**
 * What the lightbox is showing: WHICH set, and where in it we are.
 *
 * `entryId` names the set rather than holding it — null meaning "every
 * photograph on this site", an id meaning "just that record's". It held the
 * built `ViewerShot[]` instead, and that was wrong in a way nothing would have
 * reported: the array is a snapshot taken when the viewer opened, so saving an
 * annotation appended a photograph the open viewer could not see. The person
 * would have clicked Save, seen nothing change, and had no way to tell whether
 * it had worked. Naming the set means the viewer re-derives it from the entries
 * on every render, so a save shows up where it was made.
 */
type Lightbox = { entryId: string | null; index: number };

const MAX_ZOOM = 6;
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(1, value));

/**
 * One photograph tile, in whichever of its three states applies: signed and
 * displayable, refused with the server's reason, or not yet attempted.
 *
 * Shared by the Photos tab and the Entries tab deliberately. Those three states
 * are the whole of what L42–L44 were about, and two copies of them would drift:
 * one would still be saying "Loading…" over a finished failure long after the
 * other had stopped.
 */
/**
 * The saved annotation, drawn over the photograph it was drawn on.
 *
 * The portal could create annotations and could not show one: both photo
 * surfaces rendered a bare `<img>`, so a manager annotated a photograph, was
 * told it saved, and then saw the unmarked original. Same defect as mobile's,
 * same cause, same sweep. AUDIT L119.
 *
 * `fit` MUST match the `objectFit` of the `<img>` this sits over. `cover` crops
 * and `contain` letterboxes, and an SVG viewBox defaults to the latter, so an
 * overlay on a cropped tile that did not say `slice` would put every stroke
 * inboard of the thing it points at. `pointerEvents: none` so the tile's own
 * click-to-open still works through it.
 */
function AnnotationOverlay({
  photo,
  fit,
}: {
  photo: { kind?: "original" | "annotated"; annotationVector?: AnnotationVector };
  fit: "cover" | "contain";
}) {
  // `displayable` is the caller's assertion, not a guess: both call sites render
  // this only inside the `signedUrl ?` branch, which is the portal's equivalent
  // of mobile's "the image is on screen".
  const vector = selectAnnotationOverlay(photo, "displayable");
  if (!vector) return null;
  return (
    <svg
      viewBox={vector.viewBox}
      preserveAspectRatio={overlayPreserveAspectRatio(fit)}
      style={{
        position: "absolute", inset: 0, width: "100%", height: "100%",
        pointerEvents: "none",
      }}
      aria-hidden="true"
    >
      {vector.strokes.map((stroke, i) => (
        <path
          key={i}
          d={stroke.path}
          stroke={stroke.color}
          strokeWidth={stroke.width}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function PhotoTile({
  photo, index, signedUrls, errors, compact, onOpen,
}: {
  photo: EntryPhoto;
  index: number;
  signedUrls: Map<string, string>;
  errors: Map<string, string>;
  /** Small, with the caption rendered beneath by the caller rather than over the image. */
  compact?: boolean;
  /**
   * Opens the viewer on THIS tile. It takes no argument on purpose: the tile
   * knows which photograph it is, but only the caller knows which ordered set
   * that position belongs to, and a tile that built its own set would disagree
   * with the grid it sits in.
   */
  onOpen: () => void;
}) {
  const signedUrl = signedUrls.get(photo.uri);
  const failure = signedUrl ? undefined : errors.get(photo.uri);

  return (
    <div
      onClick={() => signedUrl && onOpen()}
      title={failure ?? photo.caption ?? undefined}
      style={{
        borderRadius: compact ? 8 : 12, overflow: "hidden",
        background: "var(--surface-secondary)",
        aspectRatio: "4/3",
        display: "flex", alignItems: "center", justifyContent: "center",
        border: "1px solid var(--border)",
        cursor: signedUrl ? "pointer" : "default",
        position: "relative",
        transition: "transform 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={(e) => { if (signedUrl) { (e.currentTarget as HTMLDivElement).style.transform = "scale(1.02)"; (e.currentTarget as HTMLDivElement).style.boxShadow = "0 6px 20px rgba(0,0,0,0.12)"; } }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.transform = "scale(1)"; (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; }}
    >
      {signedUrl ? (
        <>
          <img
            src={signedUrl}
            alt={photo.caption ?? `Photo ${index + 1}`}
            loading="lazy"
            decoding="async"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          {/* The tile is `position: relative` and the img fills it exactly, so
              the overlay's box IS the img's box. `cover` because the img says
              `cover`. */}
          <AnnotationOverlay photo={photo} fit="cover" />
        </>
      ) : (
        // "Loading…" under a load that has finished and failed is the defect,
        // not the styling: it tells a manager to wait for something that is
        // never coming.
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: compact ? 2 : 8, padding: compact ? 4 : 10, textAlign: "center" }}>
          <span style={{ fontSize: compact ? 18 : 32, opacity: 0.4 }}>{failure ? "⚠" : "📷"}</span>
          <span style={{ fontSize: compact ? 9 : 11, color: failure ? "var(--error)" : "var(--text-tertiary)" }}>
            {failure ? "Unavailable" : "Loading…"}
          </span>
          {failure && !compact && (
            <span style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.3 }}>{failure}</span>
          )}
        </div>
      )}
      {photo.caption && signedUrl && !compact && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "linear-gradient(transparent, rgba(15,43,70,0.75))",
          padding: "20px 10px 8px",
          fontSize: 11, color: "#fff", fontWeight: 500,
        }}>
          {photo.caption}
        </div>
      )}
    </div>
  );
}

/**
 * One metadata line in the viewer.
 *
 * `degraded` is what makes the three states of a question visibly different
 * rather than three sentences in the same grey. A photograph whose location is
 * the entry's address and one whose location is its own must not read the same,
 * because the first is a stand-in and an auditor is entitled to know that.
 */
function ViewerFact({ text, degraded }: { text: string; degraded?: boolean }) {
  return (
    <div style={{
      fontSize: 13, lineHeight: 1.45,
      color: degraded ? "var(--warning)" : "rgba(255,255,255,0.88)",
    }}>
      {degraded && <span style={{ marginRight: 6 }}>⚠</span>}
      {text}
    </div>
  );
}

/**
 * The full-screen view of one photograph, with what is known about it and a way
 * through the rest of its record.
 *
 * Every label comes from `lib/photo-capture-time.ts` and `lib/photo-provenance.ts`,
 * which are the pinned twins of mobile's copies — so the two surfaces state the
 * same thing about the same photograph, and neither one formats its own
 * sentence. Nothing here decides what is true; it decides only how an already
 * decided answer is laid out.
 *
 * `toLocaleString` runs inside `describeCaptureTime`, which is a hydration
 * hazard everywhere else in this portal (AUDIT L49) and is safe here for a
 * structural reason rather than a lucky one: this component only ever mounts in
 * response to a click, so it is never part of the server-rendered tree and
 * there is no server output for it to disagree with.
 *
 * NOT VERIFIED IN A BROWSER: this environment has no browser and no Playwright,
 * so the pointer arithmetic for pinch and pan below is reasoned, not observed.
 * The zoom buttons and the keyboard controls exist so the viewer is fully
 * usable even if that arithmetic needs tuning on a real trackpad.
 */
function PhotoLightbox({
  shots, index, signedUrls, onIndex, onClose, actorEmail, onAnnotated,
}: {
  shots: ViewerShot[];
  index: number;
  signedUrls: Map<string, string>;
  onIndex: (next: number) => void;
  onClose: () => void;
  /**
   * Who is signed in, for the annotation's provenance. Optional because the
   * page resolves it from localStorage after mount, so the viewer can briefly
   * open without it — and an unknown annotator is recorded as ABSENT rather
   * than as a blank string (see buildAnnotationDerivative).
   */
  actorEmail?: string;
  /** The entry as the API returned it after a save, so the page stops showing a guess. */
  onAnnotated?: (entry: Entry) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /**
   * Mirrors `dragFrom` as state rather than reading the ref in render. A ref
   * mutation does not re-render, so a cursor or a transition driven off
   * `dragFrom.current` would be read once and then never updated — it would
   * look like working code and do nothing.
   */
  const [dragging, setDragging] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchFrom = useRef<{ distance: number; zoom: number } | null>(null);

  // Escape to leave, arrows to move. A viewer whose only exit is a 38px mouse
  // target is not an exit for someone on a keyboard, and L51's tap-target work
  // is still open — so the keyboard path is the one that is certainly usable.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // With the annotator open these keys belong to it: Escape closes the
      // annotator (it handles its own, in the capture phase) and an arrow must
      // NOT step the photograph out from under a drawing in progress.
      if (annotating) return;
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); onIndex(stepPhotoIndex(index, -1, shots.length)); }
      if (e.key === "ArrowRight") { e.preventDefault(); onIndex(stepPhotoIndex(index, 1, shots.length)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, shots.length, onIndex, onClose, annotating]);

  // A new photograph starts unzoomed. Carrying a 4x zoom and its pan offset
  // across a step would leave the next image showing an arbitrary corner of
  // itself with no indication why.
  useEffect(() => { setZoom(1); setOffset({ x: 0, y: 0 }); setDragging(false); }, [index]);

  // Registered by hand rather than as an `onWheel` prop because React attaches
  // wheel listeners passively, where `preventDefault()` is ignored and the page
  // scrolls behind the viewer while it zooms.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const shot = shots[index];
  // Hooks above this line, unconditionally. An out-of-range index is reachable
  // if the set shrinks under an open viewer, so it is handled rather than
  // assumed away.
  if (!shot) return null;

  const signedUrl = signedUrls.get(shot.photo.uri);
  const capture = describeCaptureTime(shot.photo);
  const place = describePhotoPlace(shot.photo, shot.entry);
  const author = describePhotoAuthor(shot.photo, shot.entry);
  const derivation = describePhotoDerivation(shot, shots);
  // Pan is discarded, not stored, while the image fits the stage — there is
  // nothing off-screen to pan to, and a remembered offset would make the next
  // zoom jump.
  const pan = zoom > 1 ? offset : { x: 0, y: 0 };
  /**
   * Annotation is offered on an ORIGINAL that has an id, and nowhere else.
   *
   * The id requirement is not a style choice: `derivedFromId` has to match the
   * source's stored `id`, because that is what mobile's renderer and the
   * viewer's own `describePhotoDerivation` match on. A photograph recorded
   * before ids existed has nothing to point at, so a derivative of it would be
   * an orphan by construction — `buildAnnotationDerivative` returns null for
   * exactly that case, and the button is hidden rather than offered and refused.
   *
   * Originals-only is a narrower rule than the data allows: the builder
   * supports annotating an annotation and is tested for it. That is a UI policy
   * — one annotation layer per photograph keeps the provenance a reader has to
   * follow one step deep — and loosening it later needs no data change.
   */
  const canAnnotate =
    !!signedUrl && !!shot.photo.id && !!shot.entry.id && shot.photo.kind !== "annotated";

  const saveAnnotation = async (vector: AnnotationVector) => {
    const sourceId = shot.photo.id;
    const entryId = shot.entry.id;
    if (!sourceId || !entryId) return;
    setSavingAnnotation(true);
    setAnnotationError(null);
    try {
      const photos = buildAnnotationDerivative({
        photos: shot.entry.photos ?? [],
        sourceId,
        vector,
        // `crypto.randomUUID` needs a secure context, which the portal is
        // (https in production, localhost in dev). The fallback is not a
        // weaker id generator — a duplicate id here would attach the next
        // annotation to the wrong photograph — it is refusing to save.
        id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "",
        now: new Date().toISOString(),
        annotatedBy: actorEmail,
      });
      if (!photos || !photos[photos.length - 1]?.id) {
        setAnnotationError("Could not record this annotation against the original.");
        return;
      }
      const entry = await updateEntryPhotos(entryId, photos);
      // The page's copy is replaced with what the API returned, not with the
      // array just sent: if another client changed the entry, this is where the
      // true set arrives, and the last-write-wins caveat becomes visible rather
      // than papered over by an optimistic update.
      onAnnotated?.(entry);
      setAnnotating(false);
    } catch (err) {
      setAnnotationError(
        err instanceof Error ? err.message : "Could not save the annotation."
      );
    } finally {
      setSavingAnnotation(false);
    }
  };

  const atFirst = index === 0;
  const atLast = index === shots.length - 1;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchFrom.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      dragFrom.current = null;
      setDragging(false);
      return;
    }
    if (zoom > 1) {
      dragFrom.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      setDragging(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = pinchFrom.current;
    if (pointers.current.size >= 2 && pinch && pinch.distance > 0) {
      const [a, b] = [...pointers.current.values()];
      setZoom(clampZoom(pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance)));
      return;
    }
    const from = dragFrom.current;
    if (!from) return;
    setOffset({ x: from.ox + (e.clientX - from.x), y: from.oy + (e.clientY - from.y) });
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchFrom.current = null;
    if (pointers.current.size === 0) { dragFrom.current = null; setDragging(false); }
  };

  const navButton = (spent: boolean): React.CSSProperties => ({
    background: "rgba(255,255,255,0.15)", border: "none", color: "#fff",
    borderRadius: 10, width: 38, height: 38, fontSize: 18,
    cursor: spent ? "default" : "pointer",
    opacity: spent ? 0.3 : 1,
  });

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(10,18,30,0.94)",
        display: "flex", flexDirection: "column",
      }}
      onClick={onClose}
    >
      {/* ── top bar: where we are, how to zoom, how to leave ── */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "14px 18px", color: "#fff", fontSize: 13,
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {shots.length > 1 ? `${index + 1} of ${shots.length}` : "1 photograph"}
        </span>
        <span style={{ flex: 1 }} />
        {canAnnotate && (
          <button
            onClick={() => { setAnnotationError(null); setAnnotating(true); }}
            style={{ ...navButton(false), width: "auto", padding: "0 14px", fontSize: 13, fontWeight: 600 }}
            title="Mark up a copy of this photograph"
          >
            Annotate
          </button>
        )}
        <button onClick={() => setZoom((z) => clampZoom(z / 1.4))} style={navButton(zoom <= 1)} title="Zoom out" aria-label="Zoom out">−</button>
        <button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} style={{ ...navButton(zoom === 1), width: "auto", padding: "0 12px", fontSize: 13 }} title="Fit to screen">
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={() => setZoom((z) => clampZoom(z * 1.4))} style={navButton(zoom >= MAX_ZOOM)} title="Zoom in" aria-label="Zoom in">+</button>
        <button onClick={onClose} style={navButton(false)} title="Close (Escape)" aria-label="Close">✕</button>
      </div>

      {/* ── the annotator, over the top of the viewer ──
          Rendered inside the viewer so closing it returns to the same
          photograph at the same place in the set, rather than to the grid. */}
      {annotating && signedUrl && (
        <div onClick={(e) => e.stopPropagation()}>
          <PhotoAnnotator
            src={signedUrl}
            alt={shot.photo.caption ?? `Photograph ${index + 1}`}
            caption={shot.photo.caption}
            saving={savingAnnotation}
            error={annotationError}
            onSave={saveAnnotation}
            onCancel={() => { if (!savingAnnotation) { setAnnotating(false); setAnnotationError(null); } }}
          />
        </div>
      )}

      {/* ── the photograph ── */}
      <div
        ref={stageRef}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        style={{
          flex: 1, minHeight: 0, overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
          touchAction: "none",
          cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "default",
        }}
      >
        {signedUrl ? (
          /*
            THE TRANSFORM MOVED OFF THE IMG AND ONTO A WRAPPER, and that is the
            whole trick. The overlay has to share the photograph's box and its
            zoom/pan, or the strokes drift away from what they point at the
            moment somebody zooms. A wrapper that shrink-wraps the img gives
            both: `maxWidth/maxHeight: 100%` on the img means the wrapper ends
            up exactly the fitted image box, so an overlay filling the wrapper
            is registered with the pixels, and the transform applied once to
            the wrapper carries image and strokes together.
          */
          <div
            style={{
              position: "relative", display: "inline-block",
              maxWidth: "100%", maxHeight: "100%", lineHeight: 0,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              transition: dragging ? "none" : "transform 0.08s linear",
            }}
          >
            <img
              src={signedUrl}
              alt={shot.photo.caption ?? `Photograph ${index + 1}`}
              draggable={false}
              style={{
                maxWidth: "100%", maxHeight: "100%", objectFit: "contain",
                display: "block", userSelect: "none",
              }}
            />
            <AnnotationOverlay photo={shot.photo} fit="contain" />
          </div>
        ) : (
          // The grid can show a refused photograph as unavailable; so must this,
          // rather than an empty black rectangle that reads as a slow load.
          <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, textAlign: "center", padding: 24 }}>
            <div style={{ fontSize: 32, opacity: 0.5, marginBottom: 8 }}>⚠</div>
            This photograph could not be loaded.
          </div>
        )}
      </div>

      {/* ── what is known about it, and the way through the record ── */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          padding: "14px 18px 20px", display: "flex", gap: 16,
          alignItems: "flex-end", flexWrap: "wrap",
          background: "linear-gradient(transparent, rgba(0,0,0,0.45))",
        }}
      >
        <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 5 }}>
          {shot.photo.caption && (
            <div style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>{shot.photo.caption}</div>
          )}
          <ViewerFact text={capture.label} degraded={capture.state !== "known"} />
          <ViewerFact text={place.label} degraded={place.state !== "photograph"} />
          <ViewerFact text={author.label} degraded={author.state === "annotator-unrecorded" || author.state === "unknown"} />
          <ViewerFact text={describePhotoRecord(shot.entry)} />
          <ViewerFact text={derivation.label} degraded={derivation.state === "annotation-orphaned"} />
        </div>

        {shots.length > 1 && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => onIndex(stepPhotoIndex(index, -1, shots.length))}
              disabled={atFirst}
              style={navButton(atFirst)}
              title="Previous (left arrow)"
              aria-label="Previous photograph"
            >
              ‹
            </button>
            <button
              onClick={() => onIndex(stepPhotoIndex(index, 1, shots.length))}
              disabled={atLast}
              style={navButton(atLast)}
              title="Next (right arrow)"
              aria-label="Next photograph"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The banner that tells a manager some photographs did not load, and offers to
 * ask again. Shared by both tabs that display photographs.
 */
function PhotoFailureBanner({
  failedCount, total, requestError, onRetry,
}: {
  failedCount: number;
  total: number;
  requestError: string | null;
  onRetry: () => void;
}) {
  if (!requestError && failedCount === 0) return null;
  return (
    <div style={{
      margin: "16px 20px 0", padding: "10px 14px",
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      borderRadius: 10,
      border: "1px solid var(--error)",
      background: "var(--surface-secondary)",
      fontSize: 13, color: "var(--text-secondary)",
    }}>
      <span style={{ color: "var(--error)" }}>⚠</span>
      <span style={{ flex: 1, minWidth: 160 }}>
        {requestError
          ? `Photos could not be loaded: ${requestError}`
          : `${failedCount} of ${total} photo${total === 1 ? "" : "s"} could not be loaded.`}
      </span>
      <button className="btn-ghost" onClick={onRetry} style={{ fontSize: 12, padding: "5px 12px" }}>
        Try again
      </button>
    </div>
  );
}

function PhotosTab({
  entries, signedUrls, errors, requestError, signing, onRetry, actorEmail, onAnnotated,
}: {
  /**
   * The ENTRIES, not a flat photo list. The grid is still flat, but a tile has
   * to be able to answer which record it came from, and a flattened
   * `EntryPhoto[]` has thrown that away before this component sees it.
   */
  entries: Entry[];
  signedUrls: Map<string, string>;
  errors: Map<string, string>;
  requestError: string | null;
  signing: boolean;
  onRetry: () => void;
  /** Who is signed in, and where a saved annotation goes back to. Threaded
   *  rather than read here, so the page stays the single owner of entry state. */
  actorEmail?: string;
  onAnnotated?: (entry: Entry) => void;
}) {
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);

  // Ordered per record and concatenated, so the grid and the viewer step
  // through the photographs in the same order. If they disagreed, clicking the
  // fourth tile would open the fifth photograph.
  const shots = useMemo(() => buildViewerShotsForRecords<EntryPhoto, Entry>(entries), [entries]);
  const failedCount = shots.filter((s) => errors.has(s.photo.uri)).length;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <span>📷</span>
          <span className="card-title">Site Photos</span>
          <span className="card-count">{shots.length}</span>
          {signing && (
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              {shots.length > SIGN_BATCH_SIZE
                ? `Loading ${signedUrls.size} of ${shots.length}…`
                : "Loading…"}
            </span>
          )}
        </div>

        {/* A manager looking at grey squares is told what went wrong and can ask
            again. Shown whether the failure was per-path or whole-request. */}
        {!signing && (
          <PhotoFailureBanner failedCount={failedCount} total={shots.length} requestError={requestError} onRetry={onRetry} />
        )}

        {shots.length === 0 ? (
          <div className="empty-state"><p>No photos uploaded yet.</p></div>
        ) : (
          <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
            {shots.map((shot, i) => (
              <PhotoTile
                key={`${shot.photo.uri}-${i}`}
                photo={shot.photo}
                index={i}
                signedUrls={signedUrls}
                errors={errors}
                onOpen={() => setLightbox({ entryId: null, index: i })}
              />
            ))}
          </div>
        )}
      </div>

      {/* The site-wide set: this grid is every record's photographs at once, so
          stepping forward from the last photograph of one day lands on the
          first of the next, which is the order the grid itself shows. */}
      {lightbox && (
        <PhotoLightbox
          /* Derived here, not stored in `lightbox`, so an annotation saved
             from inside the viewer appears in the set it was added to. */
          shots={shots}
          index={lightbox.index}
          signedUrls={signedUrls}
          onIndex={(index) => setLightbox((open) => (open ? { ...open, index } : open))}
          onClose={() => setLightbox(null)}
          actorEmail={actorEmail}
          onAnnotated={onAnnotated}
        />
      )}
    </>
  );
}

/**
 * The diary entries the crew logged, read-only.
 *
 * This is the half of the product the office uses and it had no way in: the
 * Overview tab counted entries and then offered nothing to click (AUDIT L47).
 * Everything here comes from `bootstrap.entries`, already filtered to this site
 * by the page — no endpoint was added and no route was added.
 *
 * Deliberately a list and not a detail route. `sites/[id]/entries/[entryId]`
 * with its own endpoint would establish a detail-route pattern the portal has
 * nowhere else, and that decision belongs with dashboard parity rather than
 * with a photograph fix.
 */
function EntriesTab({
  entries, signedUrls, errors, requestError, signing, onRetry, formatDate, actorEmail, onAnnotated,
}: {
  entries: Entry[];
  signedUrls: Map<string, string>;
  errors: Map<string, string>;
  requestError: string | null;
  signing: boolean;
  onRetry: () => void;
  formatDate: (value?: string | null, options?: Intl.DateTimeFormatOptions) => string;
  /** Who is signed in, and where a saved annotation goes back to. Threaded
   *  rather than read here, so the page stays the single owner of entry state. */
  actorEmail?: string;
  onAnnotated?: (entry: Entry) => void;
}) {
  const [lightbox, setLightbox] = useState<Lightbox | null>(null);

  // Newest first — the office reads the most recent day first. `date` is the
  // work date and `timestamp` when it was logged; the second breaks ties within
  // a day. Both compare as ISO strings.
  const ordered = useMemo(
    () => [...entries].sort(
      (a, b) =>
        (b.date ?? "").localeCompare(a.date ?? "") ||
        (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
    ),
    [entries]
  );

  const allPhotos = entries.flatMap((e) => e.photos ?? []);
  const failedCount = allPhotos.filter((p) => errors.has(p.uri)).length;

  /**
   * The open viewer's set: just the record it was opened from.
   *
   * Empty when that record is no longer in `entries` — the viewer renders
   * nothing for an out-of-range index, so a record that disappears closes the
   * viewer rather than showing another day's photographs under its caption.
   */
  const openShots = useMemo(() => {
    const open = lightbox?.entryId
      ? entries.find((e) => e.id === lightbox.entryId)
      : undefined;
    return open ? buildViewerShots<EntryPhoto, Entry>(open) : [];
  }, [lightbox?.entryId, entries]);

  return (
    <>
      <div className="card">
        <div className="card-header">
          <span>📄</span>
          <span className="card-title">Diary Entries</span>
          <span className="card-count">{entries.length}</span>
          {signing && (
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-secondary)" }}>Loading photos…</span>
          )}
        </div>

        {!signing && (
          <PhotoFailureBanner failedCount={failedCount} total={allPhotos.length} requestError={requestError} onRetry={onRetry} />
        )}

        {entries.length === 0 ? (
          <div className="empty-state"><p>No diary entries logged yet.</p></div>
        ) : (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            {ordered.map((entry) => {
              // Scoped to THIS record, which is what "swipe between the
              // photographs on one record" asks for: stepping forward from the
              // last photograph of an entry stops there rather than silently
              // crossing into another day's evidence.
              const shots = buildViewerShots<EntryPhoto, Entry>(entry);
              return (
                <article
                  key={entry.id}
                  style={{
                    border: "1px solid var(--border)", borderRadius: 12,
                    padding: 16, background: "var(--surface)",
                  }}
                >
                  <header style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
                      {formatDate(entry.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {entry.ownerEmail ? `Logged by ${entry.ownerEmail}` : "Logged by an unrecorded account"}
                    </span>
                    {entry.timestamp && (
                      <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                        · {formatDate(entry.timestamp, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </header>

                  {(entry.weather || entry.crewCount || entry.locationAddress) && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                      {entry.weather && <span className="badge">🌤️ {entry.weather}</span>}
                      {entry.crewCount && <span className="badge">👷 {entry.crewCount}</span>}
                      {entry.locationAddress && <span className="badge">📍 {entry.locationAddress}</span>}
                    </div>
                  )}

                  <p style={{
                    margin: 0, fontSize: 13, lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    color: entry.notes?.trim() ? "var(--text)" : "var(--text-tertiary)",
                  }}>
                    {entry.notes?.trim() || "No notes recorded for this entry."}
                  </p>

                  {shots.length > 0 && (
                    <div style={{
                      marginTop: 12, display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 10,
                    }}>
                      {shots.map((shot, i) => (
                        <figure key={`${shot.photo.uri}-${i}`} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                          <PhotoTile
                            photo={shot.photo}
                            index={i}
                            signedUrls={signedUrls}
                            errors={errors}
                            compact
                            onOpen={() => setLightbox({ entryId: entry.id, index: i })}
                          />
                          {shot.photo.caption && (
                            <figcaption style={{ fontSize: 10, lineHeight: 1.3, color: "var(--text-secondary)" }}>
                              {shot.photo.caption}
                            </figcaption>
                          )}
                        </figure>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {lightbox && (
        <PhotoLightbox
          /* Rebuilt from the named record every render, for the same reason:
             the set an annotation lands in is the one on screen. */
          shots={openShots}
          index={lightbox.index}
          signedUrls={signedUrls}
          onIndex={(index) => setLightbox((open) => (open ? { ...open, index } : open))}
          onClose={() => setLightbox(null)}
          actorEmail={actorEmail}
          onAnnotated={onAnnotated}
        />
      )}
    </>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLIENT ROW OF THE SITE INFORMATION TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read-only for everyone, and a select for a manager. It is one component
 * rather than two branches at the call site so that the thing a crew member
 * sees and the thing a manager sees cannot drift into saying different words
 * about the same site.
 *
 * WHAT IT PREFERS AND WHY
 *
 * The canonical client name from `clients` first, then the site's own stored
 * `client` label. They agree immediately after any filing — the API rewrites
 * the label — and disagree after a client is renamed, until something files
 * this site again. The canonical name is the one shown on the clients screen,
 * so it is the one shown here.
 *
 * A site filed under a client NOT in the list keeps its label and is not shown
 * as unfiled, matching lib/site-grouping.ts. The select is given an extra
 * option for that id in that case, because a `<select>` whose value matches no
 * option renders blank — the control would claim the site is unfiled, and the
 * first change would make that true.
 */
function ClientFilingCell({
  site, clients, canFile, filing, error, onFile,
}: {
  site: { id: string; client: string; clientId?: string | null };
  clients: Client[];
  canFile: boolean;
  filing: boolean;
  error: string | null;
  onFile: (clientId: string | null) => void;
}) {
  const filedUnder = site.clientId ?? null;
  const canonical = filedUnder ? clients.find((c) => c.id === filedUnder)?.name : undefined;
  const label = canonical || site.client || (filedUnder ? "Filed — name unavailable" : "");

  // No list means no choices, so no control. Stated as its own branch rather
  // than folded into `canFile` because the two are different reasons and a
  // manager seeing a read-only row should be able to tell which it was.
  if (!canFile || clients.length === 0) {
    return <span>{label || "— Unfiled —"}</span>;
  }

  const unknownFiled = filedUnder !== null && canonical === undefined;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <select
        value={filedUnder ?? ""}
        disabled={filing}
        onChange={(e) => onFile(e.target.value === "" ? null : e.target.value)}
        aria-label="Client this site is filed under"
        style={{ height: 34, fontSize: 13, maxWidth: 260 }}
      >
        <option value="">— Unfiled —</option>
        {unknownFiled && (
          <option value={filedUnder}>{site.client || filedUnder}</option>
        )}
        {clients.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {filing && <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Saving…</span>}
      {error && (
        <span style={{ fontSize: 12, color: "var(--error, #ef4444)" }}>{error}</span>
      )}
      {!filing && !error && (
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          Filing only. Nothing about a client decides who may open this site.
        </span>
      )}
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE JOB-NUMBER ROW OF THE SITE INFORMATION TABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read-only for everyone, an input with a Save for a manager — the same shape
 * as ClientFilingCell above and for the same reason: the words a crew member
 * reads and the words a manager reads should not be able to drift apart.
 *
 * WHAT IT SHOWS WHEN THERE IS NONE. "—", not an empty cell and not "N/A".
 * Every site created before PR 2 has no job number, so the empty case is the
 * common one; an empty cell reads as a page that failed to load the value.
 *
 * THE DRAFT IS LOCAL AND THE SAVE IS THE CALLER'S. Save is disabled while the
 * trimmed draft equals the stored value, padding included, because the route
 * trims too — so " A-1 " over "A-1" would be a request that changes nothing.
 *
 * `maxLength` comes off the shared constant rather than a literal typed here.
 * The route REFUSES an over-long value with a 400 rather than truncating it,
 * so without the cap on the input a person types a 60-character reference and
 * is told it is invalid after the fact. assert_job_number_cap_agrees in
 * Projects/scripts/ci.sh proves this number equals the route's.
 */
function JobNumberCell({
  site, canEdit, saving, error, onSave,
}: {
  site: { id: string; jobNumber: string };
  canEdit: boolean;
  saving: boolean;
  error: string | null;
  onSave: (jobNumber: string) => void;
}) {
  const stored = normaliseJobNumber(site.jobNumber);
  const [draft, setDraft] = useState(stored);

  /**
   * Re-seed from the server's value when IT changes, not on every render.
   *
   * `stored` is the authority after a save — the route trims — so a successful
   * write has to be reflected here or the input would keep showing the
   * untrimmed draft. Keyed on `stored` rather than on a saving flag so that a
   * change made in another session and picked up by a reload also lands.
   */
  useEffect(() => { setDraft(stored); }, [stored]);

  if (!canEdit) {
    // `formatJobNumber` returns null for an absence, so the "Job #" prefix
    // cannot be printed with nothing after it. The prefix is dropped here
    // because the row is already labelled "Job Number".
    return <span>{stored || "—"}</span>;
  }

  const next = normaliseJobNumber(draft);
  const unchanged = next === stored;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <input
        type="text"
        value={draft}
        disabled={saving}
        maxLength={JOB_NUMBER_MAX_LENGTH}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Optional — e.g. 2026-NW-00123"
        aria-label="Job number for this site"
        style={{ height: 34, fontSize: 13, maxWidth: 260, padding: "0 10px" }}
      />
      <button
        type="button"
        className="btn btn-sm"
        disabled={saving || unchanged}
        onClick={() => onSave(next)}
      >
        {saving ? "Saving…" : next ? "Save" : "Remove"}
      </button>
      {error && (
        <span style={{ fontSize: 12, color: "var(--error, #ef4444)" }}>{error}</span>
      )}
      {!saving && !error && (
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          Free text, and not unique — contractors reuse a job number across sites.
        </span>
      )}
    </div>
  );
}

export default function SiteDetailPage() {
  const router = useRouter();
  const { id: siteId } = useParams<{ id: string }>();

  const [bootstrap, setBootstrap]     = useState<BootstrapData | null>(null);
  const [timecards, setTimecards]     = useState<Timecard[]>([]);
  const [incidents, setIncidents]     = useState<Incident[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [deliveries, setDeliveries]   = useState<Delivery[]>([]);
  const [loadingMain, setLoadingMain]   = useState(true);
  const [tab, setTab]                   = useState<Tab>("overview");
  const [approving, setApproving]       = useState<string | null>(null);
  /**
   * The timesheet approval controls' state.
   *
   * `approvingCard` is the id of the card with a request in flight, matching
   * `approving` above for diaries: one at a time, so the button that was pressed
   * is the one that goes quiet rather than all of them.
   *
   * `approvalError` is a single string and not a per-row map, unlike
   * `photoErrors`. Photographs fail in bulk — forty tiles, forty independent
   * signatures — but these writes happen one at a time because the manager
   * presses one button, so there is never more than one failure to report and a
   * map would be machinery for a case that cannot arise.
   */
  const [approvingCard, setApprovingCard] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  // Which row has its send-back note box open, and what has been typed into it.
  const [sendBackFor, setSendBackFor]     = useState<string | null>(null);
  const [sendBackNote, setSendBackNote]   = useState("");
  /**
   * Two things that exist only in the browser, and the React hydration errors
   * they were causing (AUDIT L49: #418, #423, #425 in the production console).
   *
   * `getSavedUser()` reads `localStorage`, and returns `null` when there is no
   * `window`. It was being called DURING render, so the server rendered the
   * sidebar as "Manager" and the browser rendered the real name from the same
   * component on the same markup — a text mismatch, which is exactly what #418
   * and #425 report. Resolved after mount instead, matching the pattern already
   * in `components/ProfileDropdown.tsx`: server and first client render agree,
   * then the effect fills in what only the browser can know.
   *
   * `mounted` gates the dates for the same reason and is not the same fact. A
   * timestamp formatted with `toLocaleDateString` uses the formatting
   * environment's time zone: the server runs in UTC and a manager's browser
   * does not, so `generatedAt` rendered an hour and minute that differed
   * between the two renders every single time. The viewer's local time is the
   * right thing to show and is unknowable on the server, so the dates wait for
   * the browser rather than being forced to a fixed zone that would be wrong
   * for somebody.
   */
  const [user, setUser] = useState<User | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setUser(getSavedUser());
    setMounted(true);
  }, []);

  const [signedPhotoUrls, setSignedPhotoUrls] = useState<Map<string, string>>(new Map());
  const [signingPhotos, setSigningPhotos]     = useState(false);
  // Per-path refusals, and the whole-request failure, kept separately: one grey
  // tile among forty is a different message from forty grey tiles.
  const [photoErrors, setPhotoErrors]         = useState<Map<string, string>>(new Map());
  const [photoRequestError, setPhotoRequestError] = useState<string | null>(null);

  const site    = bootstrap?.sites.find((s) => s.id === siteId);
  const entries = bootstrap?.entries.filter((e) => e.siteId === siteId) ?? [];
  const diaries = bootstrap?.diaries.filter((d) => d.siteId === siteId) ?? [];

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  FILING THIS SITE UNDER A CLIENT
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * PATCH /api/projects/sites/:id with { clientId }, which is
   * requireAtLeast("manager") on the API. `canFileSiteUnderClient` hides the
   * control for everyone else, and that is presentation only — the gate is the
   * route, proved red-on-revert in services/api/src/routes/clients-db.test.ts.
   * A crew member who reaches the endpoint by hand gets a 403 whatever this
   * page draws.
   *
   * The client list is fetched here rather than taken from the bootstrap,
   * which does not carry clients. A failed fetch leaves `clients` empty and the
   * control unrendered: with no list there is nothing to choose from, and a
   * select with one option that silently unfiles the site is worse than no
   * select. The label below still shows what the site is filed under, because
   * that comes from the site itself.
   */
  const { canFileSiteUnderClient, canSetSiteJobNumber } = useRole();
  const [clients, setClients] = useState<Client[]>([]);
  const [filing, setFiling] = useState(false);
  const [filingError, setFilingError] = useState<string | null>(null);
  const [savingJobNumber, setSavingJobNumber] = useState(false);
  const [jobNumberError, setJobNumberError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listClients()
      .then((list) => { if (live) setClients(list); })
      .catch(() => { /* see above: no list, no control. The site's own label stands. */ });
    return () => { live = false; };
  }, []);

  const handleFile = async (clientId: string | null) => {
    if (!site) return;
    setFiling(true);
    setFilingError(null);
    try {
      const updated = await fileSiteUnderClient(site.id, clientId);
      // The SERVER's site, not a local merge. Filing rewrites the `client`
      // label as well as `client_id`, so patching only the field we sent would
      // leave the label disagreeing with the filing until the next full load.
      setBootstrap((prev) => prev ? {
        ...prev,
        sites: prev.sites.map((x) => x.id === updated.id ? updated : x),
      } : prev);
      // The counts on the clients screen are now stale by one in two places.
      // Re-read rather than adjust them here: another manager may have filed
      // something in between, and a count this page computed would be a guess.
      listClients().then(setClients).catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not change the client.";
      setFilingError(msg);
    } finally {
      setFiling(false);
    }
  };

  /**
   * The caller for PATCH /api/projects/sites/:id/job-number — apps/supervisor-web
   * is one of the two shipping clients that make that route exist, the other
   * being apps/mobile/app/site/[id].tsx.
   */
  const handleJobNumber = async (jobNumber: string) => {
    if (!site) return;
    setSavingJobNumber(true);
    setJobNumberError(null);
    try {
      const updated = await setSiteJobNumber(site.id, jobNumber);
      // The SERVER's site, not a local merge: the route trims the value, so
      // what came back is what is stored and a merge of what we sent would
      // show the untrimmed version until the next full load.
      setBootstrap((prev) => prev ? {
        ...prev,
        sites: prev.sites.map((x) => x.id === updated.id ? updated : x),
      } : prev);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not save the job number.";
      setJobNumberError(msg);
    } finally {
      setSavingJobNumber(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/"); return; }
    Promise.all([
      fetchBootstrap(),
      fetchTimecards(siteId),
      fetchIncidents(siteId),
      fetchInspections(siteId),
      fetchDeliveries(siteId),
    ]).then(([boot, tc, inc, ins, del]) => {
      setBootstrap(boot);
      setTimecards(tc);
      setIncidents(inc);
      setInspections(ins);
      setDeliveries(del);
    }).catch(console.error).finally(() => setLoadingMain(false));
  }, [siteId]);

  /**
   * Replace one entry in the loaded bootstrap with the version the API returned.
   *
   * `entries` is derived from `bootstrap` by filter, so this is the only place
   * an entry change can be applied — and it is applied by id rather than by
   * refetching the whole bootstrap, because a refetch would discard the signed
   * photo URLs and blank every tile on the page for a second.
   *
   * An annotation derivative shares its original's `uri`, so the signing
   * pipeline already holds a signed URL for it and the new photograph renders
   * immediately with no second round trip. That is a consequence of storing a
   * vector rather than new bytes; if annotation ever rasterises to a new object
   * key, this comment is the thing that stops being true and the signing effect
   * will need to re-run.
   */
  const applyEntryUpdate = useCallback((updated: Entry) => {
    setBootstrap((prev) =>
      prev
        ? { ...prev, entries: prev.entries.map((e) => (e.id === updated.id ? updated : e)) }
        : prev
    );
  }, []);

  const photos = useMemo(() => {
    return entries.flatMap((e) => (e.photos ?? []));
  }, [entries]);

  /**
   * What still needs signing, and a stable key for it.
   *
   * A path that has been attempted is excluded whether it succeeded or failed,
   * which is a correctness requirement and not an optimisation: `photos` is a
   * fresh array on every render, so the effect below would otherwise run on
   * every render, and the only thing that stops it re-requesting is a path
   * being accounted for. When failures were discarded they were never
   * accounted for, so a single path the server refuses put the portal into an
   * unbounded loop of sign requests.
   *
   * `pendingKey` is what the effect actually depends on. The array identity
   * changes every render; the key changes only when the SET of pending paths
   * does, so the effect fires on a real change rather than on a re-render.
   */
  const pendingPhotoPaths = useMemo(
    () => photos.map((p) => p.uri).filter((u) => u && !signedPhotoUrls.has(u) && !photoErrors.has(u)),
    [photos, signedPhotoUrls, photoErrors]
  );
  const pendingKey = pendingPhotoPaths.join("\u0000");

  /**
   * The in-flight guard, and why it is a ref rather than the `signingPhotos`
   * state it used to be.
   *
   * The old condition read `signingPhotos` inside the effect while declaring
   * only `[tab, photos]` as dependencies — the exact shape
   * `eslint-plugin-react-hooks` exists to flag (not installed here on purpose;
   * that is a repo-wide change for its own branch). It happened to work only
   * because `photos` changed identity on every render, so the effect re-ran
   * often enough to see fresh state. Remove that accident — which the
   * `pendingKey` dependency above deliberately does — and a stale `false`
   * would let a second request start while the first was still open, or a
   * stale `true` would wedge signing permanently.
   *
   * A ref is not reactive, so it is never stale and never a dependency. It is
   * the right tool for "is there a request open right now"; state is the right
   * tool for "should the header say Loading", and those are two different
   * questions that were being answered by one variable.
   */
  const signInFlight = useRef(false);
  // Bumped when a request settles, to re-check for work the completed round did
  // not cover. Without it, a pending set that changes while a request is open
  // would be dropped: the effect fires, the ref refuses it, and nothing fires
  // again. Each round strictly shrinks the pending set — every path asked for
  // is recorded — so this terminates.
  const [signRound, setSignRound] = useState(0);

  // Sign photo URLs when the Photos tab is opened.
  useEffect(() => {
    // Both tabs that display photographs, sharing one signing pass: a manager
    // who opens Entries after Photos re-signs nothing, because the results are
    // keyed by path and `pendingPhotoPaths` is already empty for them.
    if ((tab !== "photos" && tab !== "entries") || pendingPhotoPaths.length === 0) return;
    if (signInFlight.current) return;

    const batch = pendingPhotoPaths.slice(0, SIGN_BATCH_SIZE);
    signInFlight.current = true;
    let cancelled = false;
    setSigningPhotos(true);
    setPhotoRequestError(null);

    signUploadPaths(batch)
      .then((results) => {
        if (cancelled) return;
        const signed = new Map<string, string>();
        const refused = new Map<string, string>();
        results.forEach(({ path, url, error }) => {
          if (url) signed.set(path, url);
          else refused.set(path, error ?? "The server returned no address for this photo.");
        });
        // A path asked for and absent from the response is neither signed nor
        // refused; record it so it is not asked for again on the next render.
        const answered = new Set(results.map((r) => r.path));
        batch.forEach((path) => {
          if (!answered.has(path)) refused.set(path, "The server did not answer for this photo.");
        });
        if (signed.size > 0) setSignedPhotoUrls((prev) => new Map([...prev, ...signed]));
        if (refused.size > 0) setPhotoErrors((prev) => new Map([...prev, ...refused]));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The whole request failed, so nothing is attributable to a path. Left
        // out of `photoErrors` on purpose: the retry below has to be able to ask
        // for all of them again.
        setPhotoRequestError(err instanceof Error ? err.message : "Could not load photos.");
      })
      .finally(() => {
        signInFlight.current = false;
        if (cancelled) return;
        setSigningPhotos(false);
        setSignRound((n) => n + 1);
      });

    // Leaving the tab or changing site abandons the result rather than writing
    // it into state that no longer belongs to it. The ref is cleared by
    // `finally` either way, so an abandoned request does not wedge the next one.
    return () => { cancelled = true; };
  }, [tab, pendingKey, signRound]);

  /**
   * A date as the viewer's browser would write it, or an em dash until the
   * browser is the one doing the writing. One helper for all three call sites
   * so a fourth cannot reintroduce the mismatch by formatting inline.
   */
  const localDate = (value?: string | null, options?: Intl.DateTimeFormatOptions) => {
    if (!value || !mounted) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString("en-AU", options);
  };

  // Retry clears the record of what was attempted, which is what lets the effect
  // above ask again.
  const retryPhotos = () => {
    setPhotoErrors(new Map());
    setPhotoRequestError(null);
  };

  const totalHours = useMemo(() => ({
    regular: timecards.reduce((s, t) => s + t.hoursRegular, 0),
    overtime: timecards.reduce((s, t) => s + t.hoursOvertime, 0),
  }), [timecards]);

  const handleApprove = async (diary: Diary) => {
    if (diary.status === "approved") return;
    setApproving(diary.id);
    try {
      const updated = await approveDiary(diary.id);
      setBootstrap((prev) => prev ? {
        ...prev,
        diaries: prev.diaries.map((d) => d.id === updated.id ? updated : d),
      } : prev);
    } catch (e) {
      console.error(e);
    } finally {
      setApproving(null);
    }
  };

  /**
   * Whether this viewer is offered the approval controls at all.
   *
   * `canApproveTimesheet(user?.companyRole)` and NOT `useRole()`, which is the
   * hook every other page uses. `useRole()` calls `getSavedUser()` during
   * render, and `getSavedUser()` reads `localStorage` — the exact shape that
   * produced the hydration mismatches recorded on the `user`/`mounted` state
   * above (AUDIT L49). This page deliberately resolves the saved user in an
   * effect instead, so it has to read the role from that state.
   *
   * `mounted &&` for the same reason the dates use it: before the effect runs
   * `user` is null, and an absent role is allowed through by design — so without
   * the gate the server and the first client render would both draw the controls
   * and a crew member would watch them disappear. Server and first render agree
   * that nothing is drawn, then the browser fills in what only it can know.
   */
  const mayApproveTimesheets = mounted && canApproveTimesheet(user?.companyRole);

  /**
   * How many cards sit in each approval state.
   *
   * Keyed off `TIMECARD_APPROVAL_STATUSES` rather than counting `"approved"` and
   * calling the rest a remainder, so a card in some state this build does not
   * recognise is counted as the pending one `normaliseApprovalStatus` reports it
   * as, and never silently inflates the approved figure. The approved count is
   * the number a manager is actually looking for — it is how much of the week's
   * payroll is signed off — so it must not be arrived at by subtraction.
   */
  const approvalCounts = useMemo(() => {
    const counts = Object.fromEntries(
      TIMECARD_APPROVAL_STATUSES.map((status) => [status, 0])
    ) as Record<TimecardApprovalStatus, number>;
    for (const tc of timecards) counts[normaliseApprovalStatus(tc.approvalStatus)] += 1;
    return counts;
  }, [timecards]);

  /**
   * Write an approval decision, and re-read the list when it is refused.
   *
   * THE RELOAD ON FAILURE IS THE POINT, NOT TIDINESS
   *
   * The one refusal this route gives that is not a bug is the 409 for a card
   * somebody else approved between this page loading and the button being
   * pressed. That means the row on screen is stale — it is drawn as pending with
   * a Send back button, and the database holds an approved card. Reporting the
   * refusal and leaving the stale row in place would leave the manager pressing
   * a button that cannot work, against a row the portal is describing wrongly.
   * Re-reading is what makes the message match what they are looking at.
   *
   * The nested catch keeps what is on screen if the re-read also fails: a failed
   * reload is not a reason to blank the table, and `approvalError` is already
   * set, so the manager is not told everything is fine.
   */
  const applyApproval = async (tc: Timecard, status: TimecardApprovalStatus, note?: string) => {
    setApprovingCard(tc.id);
    setApprovalError(null);
    try {
      const updated = await setTimecardApproval(tc.id, status, note);
      setTimecards((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      setSendBackFor(null);
      setSendBackNote("");
    } catch (e) {
      setApprovalError(
        describeApprovalFailure(e, `Could not update ${tc.workerName}'s timecard.`)
      );
      try {
        setTimecards(await fetchTimecards(siteId));
      } catch {
        /* Keep the rows already shown; the error above is what gets read. */
      }
    } finally {
      setApprovingCard(null);
    }
  };

  /**
   * The two decisions that get a confirmation, and the one that does not.
   *
   * Approving locks the card, and reopening erases who approved it and when —
   * both are consequential and neither is undone by pressing the button again,
   * so both are confirmed, which is this portal's existing convention for a
   * change of that kind (`app/team/page.tsx`, `app/settings/page.tsx`).
   *
   * Sending a card back is NOT confirmed, because it has its own surface: the
   * note box below the row, which the manager has to type into and submit. A
   * confirmation on top of that would be a second dialog for one decision.
   */
  const confirmApproveTimecard = (tc: Timecard) => {
    if (!confirm(
      `Approve ${tc.workerName}'s hours for ${tc.date}? The card is locked once approved` +
      ` — if it needs changing after that, reopen it first.`
    )) return;
    void applyApproval(tc, "approved");
  };

  const confirmReopenTimecard = (tc: Timecard) => {
    if (!confirm(
      `Reopen ${tc.workerName}'s timecard for ${tc.date}? This clears the record of who` +
      ` approved it and when, and lets them edit the hours again.`
    )) return;
    void applyApproval(tc, "pending");
  };

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />
      <div className="main">
        {/* Top bar */}
        <div className="topbar">
          <button onClick={() => router.back()} className="btn-ghost" style={{ marginRight: 8, padding: "6px 10px" }}>← Sites</button>
          <div className="topbar-title">{site?.name ?? "Site Detail"}</div>
          {site && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {(() => {
                // Canonical name first, same precedence as ClientFilingCell.
                // Written inline because this chip is the only other place the
                // client is named and a second helper for one string is worse.
                const chip = (site.clientId ? clients.find((c) => c.id === site.clientId)?.name : undefined) || site.client;
                return chip ? <span style={{ fontSize: 12, color: "var(--text-secondary)", background: "var(--surface-secondary)", padding: "4px 10px", borderRadius: 8 }}>🏢 {chip}</span> : null;
              })()}
              {site.address && <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>📍 {site.address}</span>}
            </div>
          )}
          <div style={{ marginLeft: "auto" }}><ProfileDropdown /></div>
        </div>

        {/* Tab bar */}
        <div className="tab-bar" style={{
          background: "var(--surface)",
          borderBottom: "2px solid var(--border)",
          display: "flex",
          overflowX: "auto",
          overflowY: "hidden",
          paddingLeft: 16,
          paddingRight: 16,
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        } as React.CSSProperties}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                position: "relative",
                padding: "0 16px",
                height: 44,
                background: "none",
                border: "none",
                color: tab === t.id ? "var(--accent)" : "var(--text-secondary)",
                fontWeight: tab === t.id ? 700 : 500,
                fontSize: 13,
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
                letterSpacing: tab === t.id ? "-0.01em" : undefined,
              }}
            >
              {t.label}
              {tab === t.id && (
                <span style={{
                  position: "absolute",
                  bottom: -2,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: "var(--accent)",
                  borderRadius: "2px 2px 0 0",
                }} />
              )}
            </button>
          ))}
        </div>

        <div className="page-body">
          {loadingMain && <SkeletonTable rows={5} />}

          {/* ── Overview ── */}
          {!loadingMain && tab === "overview" && site && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
                {[
                  { label: "Entries", value: entries.length, icon: "📄", color: "var(--primary)" },
                  { label: "Timecards", value: timecards.length, icon: "⏱️", color: "#0ea5e9" },
                  { label: "Incidents", value: incidents.length, icon: "⚠️", color: "#EF4444" },
                  { label: "Diaries", value: diaries.length, icon: "📋", color: "var(--accent)" },
                ].map((m) => (
                  <div key={m.label} className="metric-card" style={{ borderLeftColor: m.color }}>
                    <div style={{ fontSize: 24, marginBottom: 6 }}>{m.icon}</div>
                    <div className="metric-value" style={{ color: m.color }}>{m.value}</div>
                    <div className="metric-label">{m.label}</div>
                  </div>
                ))}
              </div>

              <div className="card">
                <div className="card-header"><span>📋</span><span className="card-title">Site Information</span></div>
                <div className="card-body">
                  <table className="data-table">
                    <tbody>
                      {([
                        ["Site Name", site.name],
                        // The one row that is not a string. Typed as ReactNode
                        // for the whole array rather than special-cased out of
                        // the loop, so the next row that needs a control does
                        // not have to be lifted out either.
                        ["Client", <ClientFilingCell
                          key="client"
                          site={site}
                          clients={clients}
                          canFile={canFileSiteUnderClient}
                          filing={filing}
                          error={filingError}
                          onFile={handleFile}
                        />],
                        // The second row that is not a string, which is what
                        // the note on the Client row above anticipated.
                        ["Job Number", <JobNumberCell
                          key="job-number"
                          site={site}
                          canEdit={canSetSiteJobNumber}
                          saving={savingJobNumber}
                          error={jobNumberError}
                          onSave={handleJobNumber}
                        />],
                        ["Address", site.address || "—"],
                        ["Start Date", localDate(site.startDate)],
                        // The raw value ("on-hold") was printed here; the shared label
                        // is what the badge on every other page shows.
                        ["Status", siteStatusCfg(site.status).label],
                        ["Total Hours Logged", `${(totalHours.regular + totalHours.overtime).toFixed(1)}h (${totalHours.regular.toFixed(1)}h reg + ${totalHours.overtime.toFixed(1)}h OT)`],
                      ] as [string, React.ReactNode][]).map(([label, value]) => (
                        <tr key={label}>
                          <td style={{ fontWeight: 600, width: 200, color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>{label}</td>
                          <td style={{ borderBottom: "1px solid var(--border)" }}>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {incidents.filter((i) => i.status === "open").length > 0 && (
                <div className="card" style={{ borderLeft: "3px solid #EF4444" }}>
                  <div className="card-header"><span>⚠️</span><span className="card-title">Open Incidents</span><span className="card-count" style={{ background: "#EF4444" }}>{incidents.filter((i) => i.status === "open").length}</span></div>
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Severity</th><th>Description</th></tr></thead>
                    <tbody>
                      {incidents.filter((i) => i.status === "open").map((inc) => {
                        const cfg = SEVERITY_CFG[inc.severity] ?? SEVERITY_CFG.minor;
                        return (
                          <tr key={inc.id}>
                            <td>{inc.date}</td>
                            <td><span className="badge" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span></td>
                            <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inc.description}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ── Timesheets ── */}
          {!loadingMain && tab === "timesheets" && (
            <div className="card">
              <div className="card-header">
                <span>⏱️</span><span className="card-title">Crew Timesheets</span>
                <span className="card-count">{timecards.length}</span>
                <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-secondary)" }}>
                  {totalHours.regular.toFixed(1)}h reg · <span style={{ color: "var(--accent)" }}>{totalHours.overtime.toFixed(1)}h OT</span> · <strong>{(totalHours.regular + totalHours.overtime).toFixed(1)}h total</strong>
                </div>
              </div>
              {approvalError && (
                <div
                  role="alert"
                  style={{
                    margin: "12px 16px 0", padding: "10px 14px", borderRadius: 6,
                    background: "#FEF2F2", border: "1px solid #FECACA",
                    color: "#991B1B", fontSize: 13, display: "flex", alignItems: "center", gap: 10,
                  }}
                >
                  <span style={{ flex: 1 }}>{approvalError}</span>
                  <button
                    className="btn-ghost"
                    style={{ fontSize: 12, padding: "4px 10px" }}
                    onClick={() => setApprovalError(null)}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {timecards.length === 0
                ? <div className="empty-state"><p>No timecard records yet.</p></div>
                : (
                <>
                  {/*
                    The approval breakdown, which is the number a manager comes to
                    this tab for: how much of these hours is signed off. Every
                    state is listed even at zero, because "0 pending" and "the
                    pending figure is missing" are different facts and a row that
                    disappears when it empties makes them look the same.
                  */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
                    {TIMECARD_APPROVAL_STATUSES.map((status) => (
                      <span
                        key={status}
                        className="badge"
                        style={{ background: APPROVAL_CFG[status].bg, color: APPROVAL_CFG[status].color }}
                      >
                        {approvalCounts[status]} {APPROVAL_CFG[status].label.toLowerCase()}
                      </span>
                    ))}
                  </div>
                  <table className="data-table">
                    <thead>
                      <tr>
                        {TIMECARD_COLUMNS.map((label) => <th key={label}>{label}</th>)}
                        {mayApproveTimesheets && <th>Approval</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {timecards.map((tc) => {
                        const status   = normaliseApprovalStatus(tc.approvalStatus);
                        const cfg      = APPROVAL_CFG[status];
                        // Not read for anything drawn here — the portal has no
                        // timecard editor — but it is what decides whether the
                        // card can still change at all, so the controls below
                        // ask it rather than comparing against "approved".
                        const open     = isTimecardEditable(status);
                        const busy     = approvingCard === tc.id;
                        const noteOpen = sendBackFor === tc.id;
                        return (
                          <Fragment key={tc.id}>
                            <tr>
                              <td>{tc.date}</td>
                              <td style={{ fontWeight: 600 }}>{tc.workerName}</td>
                              <td style={{ color: "var(--text-secondary)" }}>{tc.trade || "—"}</td>
                              <td>{formatTime(tc.startTime)}</td>
                              <td>{formatTime(tc.endTime)}</td>
                              <td>{tc.breakMinutes ? `${tc.breakMinutes}m` : "—"}</td>
                              <td>{tc.hoursRegular.toFixed(2)}h</td>
                              <td style={{ color: tc.hoursOvertime > 0 ? "var(--accent)" : "var(--text-tertiary)", fontWeight: tc.hoursOvertime > 0 ? 700 : 400 }}>{tc.hoursOvertime > 0 ? `${tc.hoursOvertime.toFixed(2)}h` : "—"}</td>
                              <td style={{ color: "var(--text-secondary)", fontSize: 12 }}>{tc.notes || "—"}</td>
                              <td>
                                <span className="badge" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                                {/*
                                  Who decided, and why. `approvedBy` is written
                                  from the session by the API and never from a
                                  request body, which is what makes a manager
                                  approving their own hours auditable rather than
                                  invisible — so it is shown, not hidden.
                                */}
                                {tc.approvedBy && (
                                  <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>
                                    {status === "rejected" ? "Sent back by " : "By "}{tc.approvedBy}
                                    {tc.approvedAt && ` · ${localDate(tc.approvedAt)}`}
                                  </div>
                                )}
                                {tc.approvalNote && (
                                  <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2, maxWidth: 220, whiteSpace: "normal" }}>
                                    “{tc.approvalNote}”
                                  </div>
                                )}
                              </td>
                              {mayApproveTimesheets && (
                                <td>
                                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                    {/*
                                      Three states, three offers. An approved card
                                      gets Reopen only: approving it again is a
                                      no-op and there is nothing to send back from
                                      a card nobody can edit. A card already sent
                                      back gets Approve only, because sending it
                                      back twice says nothing new.
                                    */}
                                    {open ? (
                                      <>
                                        {status === "pending" && (
                                          <button
                                            className="btn-ghost"
                                            style={{ fontSize: 12, padding: "5px 10px" }}
                                            disabled={busy}
                                            onClick={() => {
                                              setApprovalError(null);
                                              setSendBackNote(tc.approvalNote ?? "");
                                              setSendBackFor(noteOpen ? null : tc.id);
                                            }}
                                          >
                                            {noteOpen ? "Cancel" : "Send back"}
                                          </button>
                                        )}
                                        <button
                                          className="btn-accent"
                                          style={{ fontSize: 12, padding: "5px 10px" }}
                                          disabled={busy}
                                          onClick={() => confirmApproveTimecard(tc)}
                                        >
                                          {busy ? "…" : "✓ Approve"}
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        className="btn-ghost"
                                        style={{ fontSize: 12, padding: "5px 10px" }}
                                        disabled={busy}
                                        onClick={() => confirmReopenTimecard(tc)}
                                      >
                                        {busy ? "…" : "Reopen"}
                                      </button>
                                    )}
                                  </div>
                                </td>
                              )}
                            </tr>
                            {mayApproveTimesheets && noteOpen && (
                              <tr>
                                <td colSpan={TIMECARD_COLUMNS.length + 1} style={{ background: "var(--surface-2, #FAFAFA)" }}>
                                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "4px 0" }}>
                                    <textarea
                                      value={sendBackNote}
                                      onChange={(e) => setSendBackNote(e.target.value)}
                                      maxLength={TIMECARD_NOTE_MAX_LENGTH}
                                      rows={2}
                                      placeholder={`Why is ${tc.workerName}'s timecard going back? They will see this.`}
                                      style={{ flex: 1, fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", fontFamily: "inherit", resize: "vertical" }}
                                    />
                                    <button
                                      className="btn-accent"
                                      style={{ fontSize: 12, padding: "6px 12px" }}
                                      disabled={busy || sendBackNote.trim().length === 0}
                                      onClick={() => void applyApproval(tc, "rejected", sendBackNote)}
                                    >
                                      {busy ? "…" : "Send back"}
                                    </button>
                                  </div>
                                  {/*
                                    The note is required HERE and optional at the
                                    API, which takes it as `z.string().optional()`.
                                    That is not a disagreement: the route has to
                                    stay callable by the mobile screen, which has
                                    nowhere to type one. This surface has a
                                    keyboard, and a card sent back with no reason
                                    tells the worker only that somebody was
                                    unhappy — so it is refused where the reason can
                                    actually be written.
                                  */}
                                  <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                                    A reason is required here. Sending the card back lets {tc.workerName} edit it again.
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </>
                )
              }
            </div>
          )}

          {/* ── Incidents ── */}
          {!loadingMain && tab === "incidents" && (
            <div className="card">
              <div className="card-header"><span>⚠️</span><span className="card-title">Incident Reports</span><span className="card-count">{incidents.length}</span></div>
              {incidents.length === 0
                ? <div className="empty-state"><p>No incidents recorded.</p></div>
                : (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Severity</th><th>Description</th><th>Injured Party</th><th>Corrective Action</th><th>Status</th></tr></thead>
                    <tbody>
                      {incidents.map((inc) => {
                        const cfg = SEVERITY_CFG[inc.severity] ?? SEVERITY_CFG.minor;
                        return (
                          <tr key={inc.id}>
                            <td>{inc.date}</td>
                            <td><span className="badge" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span></td>
                            <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{inc.description}</td>
                            <td style={{ color: "var(--text-secondary)" }}>{inc.injuredParty || "—"}</td>
                            <td style={{ color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{inc.correctiveAction || "—"}</td>
                            <td>
                              <span className="badge" style={{ background: inc.status === "closed" ? "#F0FDF4" : "#FEF9C3", color: inc.status === "closed" ? "#22C55E" : "#CA8A04" }}>
                                {inc.status === "closed" ? "Closed" : "Open"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              }
            </div>
          )}

          {/* ── Inspections ── */}
          {!loadingMain && tab === "inspections" && (
            <div className="card">
              <div className="card-header"><span>🔍</span><span className="card-title">Site Inspections</span><span className="card-count">{inspections.length}</span></div>
              {inspections.length === 0
                ? <div className="empty-state"><p>No inspections recorded.</p></div>
                : (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Status</th><th>Score</th><th>Notes</th><th>Items</th></tr></thead>
                    <tbody>
                      {inspections.map((ins) => {
                        const passed = ins.results?.filter((r) => r.passed === true).length ?? 0;
                        const total  = ins.results?.length ?? 0;
                        return (
                          <tr key={ins.id}>
                            <td>{ins.date}</td>
                            <td>
                              <span className="badge" style={{ background: ins.status === "pass" ? "#F0FDF4" : ins.status === "fail" ? "#FEF2F2" : "#FFF7ED", color: ins.status === "pass" ? "#22C55E" : ins.status === "fail" ? "#EF4444" : "#F59E0B" }}>
                                {ins.status?.toUpperCase() ?? "—"}
                              </span>
                            </td>
                            <td>{total > 0 ? `${passed}/${total} passed` : "—"}</td>
                            <td style={{ color: "var(--text-secondary)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{ins.notes || "—"}</td>
                            <td style={{ color: "var(--text-tertiary)", fontSize: 12 }}>{total} checklist items</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              }
            </div>
          )}

          {/* ── Dockets ── */}
          {!loadingMain && tab === "dockets" && (
            <div className="card">
              <div className="card-header"><span>📦</span><span className="card-title">Delivery Dockets</span><span className="card-count">{deliveries.length}</span></div>
              {deliveries.length === 0
                ? <div className="empty-state"><p>No deliveries recorded.</p></div>
                : (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Supplier</th><th>Items</th><th>Quantity</th><th>Notes</th><th>Status</th></tr></thead>
                    <tbody>
                      {deliveries.map((d) => (
                        <tr key={d.id}>
                          <td>{d.date}</td>
                          <td style={{ fontWeight: 600 }}>{d.supplier || "—"}</td>
                          <td style={{ color: "var(--text-secondary)" }}>{d.items?.join(", ") || "—"}</td>
                          <td>{d.quantity || "—"}</td>
                          <td style={{ color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{d.notes || "—"}</td>
                          <td>
                            <span className="badge" style={{ background: "#F0FDF4", color: "#22C55E" }}>
                              {d.status ?? "Received"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </div>
          )}

          {/* ── Entries ── */}
          {!loadingMain && tab === "entries" && (
            <EntriesTab
              entries={entries}
              signedUrls={signedPhotoUrls}
              errors={photoErrors}
              requestError={photoRequestError}
              signing={signingPhotos}
              onRetry={retryPhotos}
              formatDate={localDate}
              actorEmail={user?.email}
              onAnnotated={applyEntryUpdate}
            />
          )}

          {/* ── Photos ── */}
          {!loadingMain && tab === "photos" && (
            <PhotosTab
              entries={entries}
              signedUrls={signedPhotoUrls}
              errors={photoErrors}
              requestError={photoRequestError}
              signing={signingPhotos}
              onRetry={retryPhotos}
              actorEmail={user?.email}
              onAnnotated={applyEntryUpdate}
            />
          )}

          {/* ── Reports ── */}
          {!loadingMain && tab === "reports" && (
            <div className="card">
              <div className="card-header"><span>📋</span><span className="card-title">AI Diary Reports</span><span className="card-count">{diaries.length}</span></div>
              {diaries.length === 0
                ? (
                  <div className="empty-state">
                    <p>No reports generated for this site yet.</p>
                    <p style={{ fontSize: 12, marginTop: 8 }}>Workers generate reports from the mobile app.</p>
                  </div>
                )
                : diaries.map((diary) => (
                  <div key={diary.id} style={{ padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                          <span className="badge" style={{ background: diary.status === "approved" ? "#F0FDF4" : "#FFFBEB", color: diary.status === "approved" ? "#22C55E" : "#F59E0B", textTransform: "uppercase", fontSize: 10 }}>
                            {diary.status}
                          </span>
                          <span className="badge" style={{ background: "var(--surface-secondary)", color: "var(--text-secondary)", textTransform: "uppercase", fontSize: 10 }}>
                            {diary.reportPeriod ?? "daily"}
                          </span>
                          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                            {localDate(diary.generatedAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        {diary.summary && <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0, maxWidth: 600 }}>{diary.summary}</p>}
                        {diary.signedBy && (
                          <div style={{ marginTop: 8, fontSize: 12, color: "var(--success)", fontWeight: 600 }}>
                            ✅ Approved by {diary.signedBy} · {localDate(diary.signedAt)}
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
                        {diary.status !== "approved" && (
                          <button
                            className="btn-accent"
                            style={{ padding: "8px 16px", fontSize: 13 }}
                            disabled={approving === diary.id}
                            onClick={() => void handleApprove(diary)}
                          >
                            {approving === diary.id ? "…" : "✓ Approve"}
                          </button>
                        )}
                        <button
                          className="btn-ghost"
                          style={{ padding: "8px 14px", fontSize: 13 }}
                          onClick={() => router.push(`/reports?siteId=${siteId}&diaryId=${diary.id}`)}
                        >
                          View Full Report
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
