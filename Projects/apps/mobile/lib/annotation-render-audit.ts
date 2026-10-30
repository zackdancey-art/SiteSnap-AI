/**
 * Every photograph surface must be able to draw an annotation, as a thing a
 * machine checks.
 *
 * THE RULE
 *
 * A stored annotation is a stroke vector on a derivative `Photo` record, not an
 * image (see `lib/annotation-render.ts`). It becomes visible only when the
 * component rendering that record knows to draw `annotationVector`. Exactly one
 * component does: `components/AnnotatedImage.tsx`. So the rule is:
 *
 *   No screen renders a Photo through anything but `AnnotatedImage`.
 *
 * `EvidenceImage` is permitted in exactly one place — inside `AnnotatedImage`,
 * which wraps it.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 *
 * Because the convention was already broken on four of six surfaces and nothing
 * noticed for twenty-five days. `app/entry/[id].tsx` gained the Annotate button
 * and the save handler on 5 October (d633ed5) and was never given the renderer;
 * `app/diary-gallery/[siteId].tsx` never had it either. The annotation saved,
 * synced, came back with its vector intact, and was displayed as the unmarked
 * original. AUDIT L119.
 *
 * The failure mode is what makes a test necessary rather than tidy. Forgetting
 * the overlay produces NO error, NO empty space and NO blank tile — it produces
 * the original photograph, which is a perfectly plausible thing to see. There is
 * no symptom for a reviewer to notice and no exception for Sentry to catch. The
 * only way to find it is to ask the source tree which component each surface
 * uses, which is what this module does.
 *
 * WHY A REGEX AND NOT THE TYPESCRIPT PARSER
 *
 * Unlike `lib/screen-header-audit.ts`, which has to resolve a registration
 * written in three different shapes, the thing being matched here is a JSX
 * opening element name. `<AnnotatedImage` is lexically unambiguous: it cannot be
 * spelled any other way and cannot be computed. A parser would add a dependency
 * on the compiler API to read one token.
 *
 * WHAT THIS CHECK CANNOT SEE, stated plainly because a structural check that
 * oversells itself is worse than none:
 *
 *   - It cannot prove a drawn overlay is drawn CORRECTLY. Alignment, z-order
 *     and whether the strokes are visible against the photograph are not
 *     readable from the source tree. `lib/annotation-render.test.ts` pins the
 *     fit rule; the pixels are a device check.
 *   - It cannot see a surface that renders a photograph by a route it does not
 *     know about — a third component, or a web view. `bypasses` below catches
 *     the one known shape (a bare `<Image source={{ uri: … }}`) and nothing
 *     else, so a genuinely new mechanism would pass unseen.
 *   - It cannot see the portal. The portal's copy of the same defect is real
 *     and was fixed in the same commit, but it renders with `<img>` inside a
 *     JSX tree this module's vocabulary does not cover.
 *   - It says nothing about whether a surface SHOULD show photographs at all.
 */

/** path (relative to the mobile package) → file contents. */
export type VirtualFiles = Record<string, string>;

/** The only component that may render a Photo in a screen. */
export const VECTOR_CAPABLE = "AnnotatedImage";

/** Renders the photograph and nothing over it. Permitted only in the wrapper. */
export const PHOTO_ONLY = "EvidenceImage";

/**
 * The one file allowed to render `EvidenceImage` directly: the wrapper that adds
 * the overlay. Named rather than pattern-matched, so moving or renaming the
 * wrapper is a deliberate edit to this list and not a silently widened licence.
 */
export const OVERLAY_WRAPPER = "components/AnnotatedImage.tsx";

export type RenderSite = {
  file: string;
  component: typeof VECTOR_CAPABLE | typeof PHOTO_ONLY;
  line: number;
};

export type BypassSite = { file: string; line: number; text: string };

export type AnnotationRenderAudit = {
  /** Every file examined, whether or not it renders a photograph. */
  files: string[];
  /** Every photo render site found, in file then line order. */
  sites: RenderSite[];
  vectorCapable: RenderSite[];
  photoOnly: RenderSite[];
  /** `photoOnly` sites outside `OVERLAY_WRAPPER`. Non-empty means the rule is broken. */
  offenders: RenderSite[];
  /** Bare `<Image source={{ uri: … }}` — the shape that predated `EvidenceImage`. */
  bypasses: BypassSite[];
};

/**
 * Blank out comments while preserving line numbering, so a reported line still
 * points at the right line of the real file.
 *
 * Deliberately crude and deliberately documented: block comments are emptied
 * line by line, and a line whose first non-space character is `//` or `*` is
 * emptied. A trailing `// …` after real code is NOT removed, because stripping
 * it safely means knowing whether the `//` is inside a string literal, and
 * `https://` is common enough in this codebase that guessing is worse than
 * leaving it. The consequence is one-directional and therefore acceptable: a
 * trailing comment that mentions `<AnnotatedImage` could register a render site
 * that does not exist, which makes the population count too HIGH and fails the
 * equality — it cannot hide a real offender.
 */
function blankComments(source: string): string[] {
  const lines = source.split("\n");
  let inBlock = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes("*/")) inBlock = false;
      return "";
    }
    if (trimmed.startsWith("/*") || trimmed.startsWith("{/*")) {
      if (!trimmed.includes("*/")) inBlock = true;
      return "";
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";
    return line;
  });
}

export function auditAnnotationRender(files: VirtualFiles): AnnotationRenderAudit {
  const sites: RenderSite[] = [];
  const bypasses: BypassSite[] = [];
  const paths = Object.keys(files).sort();

  for (const file of paths) {
    const lines = blankComments(files[file]);
    lines.forEach((line, i) => {
      const lineNo = i + 1;
      // The trailing `(?![A-Za-z0-9_])` is not defensive padding, it is load
      // bearing: `React.useState<EvidenceImageStatus>(…)` contains the literal
      // text `<EvidenceImage`, and matching it would book a type argument as a
      // render site. That is a false POSITIVE, which here means the pinned
      // population is wrong and the equality fails on an edit that changed
      // nothing — a check that cries wolf gets deleted, and then it is not
      // checking anything at all.
      if (new RegExp(`<${VECTOR_CAPABLE}(?![A-Za-z0-9_])`).test(line)) {
        sites.push({ file, component: VECTOR_CAPABLE, line: lineNo });
      }
      if (new RegExp(`<${PHOTO_ONLY}(?![A-Za-z0-9_])`).test(line)) {
        sites.push({ file, component: PHOTO_ONLY, line: lineNo });
      }
      // `source={{ uri:` is the shape EvidenceImage was created to replace. It
      // is matched on the same line as `<Image` only when they are together;
      // the multi-line spelling is caught by the `uri:` half alone being on a
      // line inside an element this audit does not track, which it cannot see.
      // Stated in the limits above rather than papered over.
      if (/<Image\b[^>]*source=\{\{\s*uri:/.test(line) || /^\s*source=\{\{\s*uri:\s*photo/.test(line)) {
        bypasses.push({ file, line: lineNo, text: line.trim() });
      }
    });
  }

  sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  const vectorCapable = sites.filter((s) => s.component === VECTOR_CAPABLE);
  const photoOnly = sites.filter((s) => s.component === PHOTO_ONLY);
  const offenders = photoOnly.filter((s) => s.file !== OVERLAY_WRAPPER);

  return { files: paths, sites, vectorCapable, photoOnly, offenders, bypasses };
}
