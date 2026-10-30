import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  OVERLAY_WRAPPER,
  PHOTO_ONLY,
  VECTOR_CAPABLE,
  auditAnnotationRender,
  type VirtualFiles,
} from "@/lib/annotation-render-audit";

/**
 * THE CHECK THAT WOULD HAVE CAUGHT AUDIT L119.
 *
 * Four of mobile's six photo surfaces rendered evidence through a component
 * that cannot draw a stroke, so a saved annotation displayed as the unmarked
 * original. The reason no test went red is that there was no test: the rule
 * "every photo surface can draw an annotation" lived nowhere except in the
 * habit of whoever last wrote a screen, and two screens were written without it
 * — one of them the screen that saves annotations.
 *
 * THE VACUITY PROBLEM THIS FILE IS BUILT AROUND
 *
 * A test that enumerates a directory passes by enumerating nothing. "No surface
 * violates the rule" is satisfied by zero surfaces, so if the path is wrong or a
 * rename empties the walk, this file goes green having checked nothing. That has
 * happened in this project four times (docs/VACUITY-AUDIT.md).
 *
 * So every population below is pinned as an EQUALITY, not a floor (AUDIT L112):
 * the file count, the render-site count, and the exact list of surfaces. A
 * screen deleted, added or renamed fails this file and is meant to — the number
 * moves in the same commit as the screen, which is the point.
 */

// `__dirname` is `dist-test/lib` at run time, so the package root is two up.
const PKG = path.resolve(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "components"];

/**
 * Pinned populations, measured at the tip of fix/pr2b-annotation-save.
 *
 * 56 = 40 files in app/ + 16 in components/.
 */
const EXPECTED_FILES = 56;
/** 6 surfaces draw photographs; the 7th site is `EvidenceImage` inside the wrapper. */
const EXPECTED_SITES = 7;

/**
 * Every surface that renders a photograph, by file. THE POPULATION, not a
 * sample: this is the list the L119 sweep examined, and four of these six sites
 * were the defect. Pinned as a sorted equality so a seventh surface cannot
 * appear without this line changing.
 */
const EXPECTED_SURFACES = [
  "app/diary-gallery/[siteId].tsx",
  "app/diary-gallery/[siteId].tsx",
  "app/entry/[id].tsx",
  "app/entry/[id].tsx",
  "app/inspections/[siteId].tsx",
  "app/new-entry.tsx",
];

function readTree(dir: string, prefix: string): VirtualFiles {
  const files: VirtualFiles = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, readTree(full, rel));
    else if (entry.name.endsWith(".tsx")) files[rel] = fs.readFileSync(full, "utf8");
  }
  return files;
}

function realTree(): VirtualFiles {
  const files: VirtualFiles = {};
  for (const dir of SCANNED_DIRS) Object.assign(files, readTree(path.join(PKG, dir), dir));
  return files;
}

test("the source tree is where this test thinks it is", () => {
  for (const dir of SCANNED_DIRS) {
    const full = path.join(PKG, dir);
    assert.ok(
      fs.existsSync(full),
      `${dir}/ not found at ${full}. Every assertion below would pass over an ` +
        `empty tree, so this is a hard failure rather than a silent clean run.`
    );
  }
  assert.ok(
    fs.existsSync(path.join(PKG, OVERLAY_WRAPPER)),
    `${OVERLAY_WRAPPER} does not exist. It is the only component permitted to ` +
      `render ${PHOTO_ONLY} directly, so if it has moved this audit's one ` +
      `exemption now points at nothing and the rule it encodes is wrong.`
  );
});

test("the real source tree has the populations this test expects to find", () => {
  const audit = auditAnnotationRender(realTree());

  assert.equal(
    audit.files.length,
    EXPECTED_FILES,
    `examined ${audit.files.length} files, expected ${EXPECTED_FILES}. A screen ` +
      `was added or removed: change the number in the same commit.`
  );
  assert.equal(
    audit.sites.length,
    EXPECTED_SITES,
    `found ${audit.sites.length} photo render sites, expected ${EXPECTED_SITES}:\n  ` +
      audit.sites.map((s) => `${s.file}:${s.line} ${s.component}`).join("\n  ")
  );
  assert.deepEqual(
    audit.vectorCapable.map((s) => s.file).sort(),
    EXPECTED_SURFACES,
    "the set of surfaces drawing annotations has changed"
  );
});

test("no screen renders a photograph through a component that cannot draw an annotation", () => {
  const audit = auditAnnotationRender(realTree());

  assert.deepEqual(
    audit.offenders.map((s) => `${s.file}:${s.line}`),
    [],
    `these surfaces render a Photo through ${PHOTO_ONLY}, so an annotation ` +
      `saved against it is stored and never drawn — the AUDIT L119 defect:\n  ` +
      audit.offenders.map((s) => `${s.file}:${s.line}`).join("\n  ")
  );

  // POSITIVE CONTROL, same function, same shape of input. `offenders` being
  // empty is a negative assertion and passes just as well against an auditor
  // that finds nothing at all — which is precisely how this defect survived.
  // So prove the auditor still recognises the defect it was written for.
  const regressed: VirtualFiles = {
    "app/entry/[id].tsx": `<${PHOTO_ONLY} photo={photo} variant="thumb" />`,
  };
  const control = auditAnnotationRender(regressed);
  assert.equal(control.offenders.length, 1, "the auditor no longer detects the defect it exists for");
  assert.equal(control.offenders[0].file, "app/entry/[id].tsx");
  assert.equal(control.offenders[0].line, 1);

  // And the exemption is exactly one file wide: the same text inside the
  // wrapper is permitted, and nowhere else is.
  const wrapper = auditAnnotationRender({ [OVERLAY_WRAPPER]: `<${PHOTO_ONLY} photo={photo} />` });
  assert.equal(wrapper.photoOnly.length, 1, "the wrapper's own render site was not seen at all");
  assert.deepEqual(wrapper.offenders, [], "the wrapper is not exempt and must be");
});

test("a type argument is not mistaken for a render site", () => {
  // `useState<EvidenceImageStatus>` contains the literal text `<EvidenceImage`.
  // Booking it as a render site would put the pinned counts permanently wrong.
  const audit = auditAnnotationRender({
    "components/Thing.tsx": `const [s, set] = React.useState<${PHOTO_ONLY}Status>("loading");`,
  });
  assert.deepEqual(audit.sites, []);

  // Positive control: the real element on the next line IS found.
  const real = auditAnnotationRender({
    "components/Thing.tsx": `useState<${PHOTO_ONLY}Status>("loading");\n<${PHOTO_ONLY} photo={p} />`,
  });
  assert.equal(real.sites.length, 1);
  assert.equal(real.sites[0].line, 2);
});

test("a commented-out render site is not counted, and a real one beside it is", () => {
  const audit = auditAnnotationRender({
    "app/x.tsx": [
      "/*",
      ` * <${PHOTO_ONLY} photo={p} /> -- described in prose, not rendered`,
      " */",
      `// <${PHOTO_ONLY} photo={p} />`,
      `{/* <${PHOTO_ONLY} photo={p} /> */}`,
      `<${VECTOR_CAPABLE} photo={p} />`,
    ].join("\n"),
  });
  assert.deepEqual(audit.photoOnly, [], "prose about the component was counted as a use of it");
  assert.equal(audit.vectorCapable.length, 1, "the real render site on line 6 was missed");
  assert.equal(audit.vectorCapable[0].line, 6, "line numbering did not survive comment blanking");
});

/**
 * The only two bare `<Image source={{ uri }}>` renders in the tree, both of
 * them the signed-in user's own avatar.
 *
 * ENUMERATED RATHER THAN EXCLUDED BY NARROWING THE MATCHER. The matcher could
 * be restricted to identifiers containing "photo" and these two would stop
 * appearing — and so would the next bare `<Image>` over a site photograph that
 * happened to be called `shot` or `item`. An exemption list fails when it grows;
 * a narrowed regex fails silently, which is the whole mechanism of AUDIT L119.
 *
 * An avatar is genuinely not in scope: it is a URI on a profile, not a `Photo`
 * record, it can never be an annotation derivative, and it is not evidence. What
 * this list asserts is that the set of such renders is exactly these two.
 */
const KNOWN_NON_EVIDENCE_IMAGES = ["app/(tabs)/settings.tsx:149", "app/profile.tsx:78"];

test("no bare <Image> renders site evidence, and the two that render an avatar are the known two", () => {
  const audit = auditAnnotationRender(realTree());
  assert.deepEqual(
    audit.bypasses.map((b) => `${b.file}:${b.line}`),
    KNOWN_NON_EVIDENCE_IMAGES,
    `the set of bare <Image> renders has changed. A NEW one over a site ` +
      `photograph is the AUDIT L119 defect by another route; a new one over an ` +
      `avatar belongs on KNOWN_NON_EVIDENCE_IMAGES with its reason:\n  ` +
      audit.bypasses.map((b) => `${b.file}:${b.line} ${b.text}`).join("\n  ")
  );

  // Positive control: the shape this is looking for is still recognised. Without
  // it, the empty list above is also what a broken matcher returns.
  const control = auditAnnotationRender({
    "app/y.tsx": `<Image source={{ uri: photo.uri }} style={styles.photo} />`,
  });
  assert.equal(control.bypasses.length, 1, "the bypass matcher no longer matches the shape it names");
});
