/**
 * The colours of the exported diary, inspection and register documents — the
 * artefact this product exists to produce, and the copy a client or a regulator
 * actually reads.
 *
 * AUDIT L63. `lib/export-utils.ts` carried 28 hex literals, 14 distinct, and did
 * not import `@/constants/colors` at all: five of them were frozen copies of a
 * design token by value, and nine were a second navy-and-grey scale that existed
 * nowhere in the token file — governed by nothing, reviewed by nobody, and
 * invisible to any decision made about the app's palette. Same shape as A6 and
 * L36, the legal-text drift: several copies of one thing, each internally
 * consistent, with no check comparing them.
 *
 * WHY THE FIVE TOKEN DUPLICATES ARE STILL LITERALS HERE
 *
 * The obvious fix is `heroStart: Colors.primary`, and it is the wrong one for
 * this file. L63's disposition is explicit that "changing export colours changes
 * already-exported evidence", and importing the token means the next change to
 * the app's navy silently restyles every document produced after it — including
 * re-exports of records signed under the old appearance. A compliance artefact
 * that quietly follows the app's branding is not a property anybody asked for.
 *
 * What L63 actually objects to is the SILENCE: "change the token and the app
 * moves while every future export keeps the old value, with nothing reporting
 * the disagreement." So the values stay frozen and deliberately independent, and
 * the disagreement is made loud instead — `scripts/assert-export-palette.mjs`
 * fails the build when a token moves away from its export twin, naming both.
 * The decision then gets made deliberately, in a commit, by someone who can
 * weigh it against the already-exported documents.
 *
 * Deciding the other way — that exports should track the tokens — is a one-line
 * change per colour and is the owner's call, not a refactor's.
 *
 * WHY THE VALUES ARE LOWERCASE
 *
 * They are lowercase in the CSS this replaces, and `constants/colors.ts` is
 * uppercase. CSS hex is case-insensitive so nothing renders differently either
 * way, but writing them as they already appear keeps the generated HTML
 * byte-identical, which is the one form of "no change" that needs no argument.
 * The drift check compares case-insensitively.
 *
 * NAMES ARE BY ROLE, NOT BY HUE. `#6f8095` is `mutedLabel` rather than
 * `grey500`, because the nine ungoverned colours have no scale to belong to and
 * naming them as if they did would invent a second design system by accident.
 */

/**
 * The five that duplicate a token in `constants/colors.ts` by value. The twin is
 * named in each comment and asserted by scripts/assert-export-palette.mjs.
 */
const TOKEN_TWINS = {
  /** Body text, meta values, section headings. Twin: Colors.primary / Colors.text. */
  text: "#0f2b46",
  /** The document sheet, and text on the navy hero. Twin: Colors.white / Colors.surface. */
  sheet: "#ffffff",
  /** Border of the "image not included" and "incomplete record" notices. Twin: Colors.warningBorder. */
  noticeBorder: "#fcd34d",
  /** Fill of those notices. Twin: Colors.warningBg. */
  noticeBg: "#fef3c7",
  /** Their text. Twin: Colors.warningText. */
  noticeText: "#92400e",
} as const;

/**
 * The nine that exist nowhere in the token file. Kept as a separate object so
 * the two groups are never confused: everything here is ungoverned by design,
 * and nothing should be added without deciding whether it belongs in
 * `constants/colors.ts` instead.
 *
 * Why they are not simply folded into the tokens: they are print values, chosen
 * for a white A4 page under a printer's gamma, and the app's scale is chosen for
 * a backlit phone screen. `heroEnd` (#143a5b) is a worked example — it is NOT
 * Colors.primaryLight (#1a3d5c), and the two were almost certainly picked
 * independently for the gradient to read correctly in each medium. Merging them
 * would be a visual change to the evidence, which is the thing L63's disposition
 * rules out.
 */
const PRINT_ONLY = {
  /** The ground behind the document sheet. */
  pageGround: "#eef2f7",
  /** Far end of the hero's navy gradient. Not Colors.primaryLight — see above. */
  heroEnd: "#143a5b",
  /** Fill of the metadata cards and of table headers. */
  panelFill: "#f6f8fb",
  /** Metadata card border, and the rule under a table header. */
  panelBorder: "#dde5ef",
  /** Uppercase field labels, table headers, the footer. */
  mutedLabel: "#6f8095",
  /** Border of a content section. */
  sectionBorder: "#e3eaf2",
  /** Paragraph and checklist body text — lighter than `text`, for long prose. */
  bodyProse: "#31455d",
  /** Row rule in the two-column detail table. */
  detailRule: "#e6edf5",
  /** Row rule in the multi-column data table. */
  dataRule: "#edf1f7",
} as const;

export const EXPORT_PALETTE = { ...TOKEN_TWINS, ...PRINT_ONLY } as const;

/**
 * The twin of each token-duplicating colour, as a key of `Colors`. Read by
 * scripts/assert-export-palette.mjs; exported rather than written in the script
 * so the mapping lives next to the values it describes.
 *
 * `text` and `sheet` each duplicate TWO tokens that are themselves equal
 * (primary/text, white/surface); one is named per colour, and the check proves
 * that one.
 */
export const EXPORT_PALETTE_TOKEN_TWINS: Readonly<Record<keyof typeof TOKEN_TWINS, string>> = Object.freeze({
  text: "primary",
  sheet: "white",
  noticeBorder: "warningBorder",
  noticeBg: "warningBg",
  noticeText: "warningText",
});
