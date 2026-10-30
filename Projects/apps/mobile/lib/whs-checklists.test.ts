import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_PREFIX,
  builtInIdFromSelection,
  builtInSelectionId,
  isBuiltInSelection,
  resolveChecklistItems,
  suggestedInspectionName,
  templateIdForCreate,
  type UserChecklistTemplate,
  type WhsChecklist,
} from "./whs-checklists";

/**
 * The assertion this file exists for is the first one: a built-in checklist id
 * must never be sent as `templateId`.
 *
 * site_inspections.template_id is
 * `TEXT REFERENCES inspection_templates(id) ON DELETE SET NULL` (migration
 * 009). A built-in checklist is compiled into the API and is not a row in that
 * table, so sending its id is a foreign-key violation — a 500 in production and
 * a 201 against the in-memory store, which has no constraints. The screen holds
 * ONE string for both kinds of selection, so the mistake is a single forgotten
 * conversion away, and the in-memory store will never report it.
 *
 * The API refuses an unknown templateId independently (services/api/src/routes/inspections.ts
 * and inspection-template-id-db.test.ts, against Postgres). This is the client
 * half: it stops the request being made rather than making it and handling the
 * refusal.
 */

const BUILT_INS: WhsChecklist[] = [
  { id: "pre-start-daily", name: "Daily Pre-Start Safety Checklist", category: "pre-start", items: ["a", "b", "c"] },
  { id: "swms-review", name: "SWMS Review", category: "swms", items: ["x", "y"] },
];

const USER_TEMPLATES: UserChecklistTemplate[] = [
  { id: "bdbf1e9c-0000-4000-8000-000000000001", name: "Our scaffold check", items: ["p", "q"] },
];

const FALLBACK = ["PPE worn by all workers", "Site boundary secured"];

test("a built-in checklist is never sent as templateId, and a real template id still is", () => {
  // THE FOREIGN KEY. A built-in id reaching template_id is a 500 in prod.
  assert.equal(templateIdForCreate(builtInSelectionId("pre-start-daily")), null);
  assert.equal(templateIdForCreate("whs:anything-at-all"), null);
  assert.equal(templateIdForCreate(`${BUILT_IN_PREFIX}swms-review`), null);

  // POSITIVE CONTROL, same function, same test. Without it, a
  // `templateIdForCreate` that returned null unconditionally would satisfy
  // every assertion above — and silently throw away the template reference on
  // every inspection created from a company's own checklist, which is a
  // compliance record losing its provenance rather than an error anybody sees.
  const real = USER_TEMPLATES[0].id;
  assert.equal(templateIdForCreate(real), real, "a real inspection_templates id must still be sent");

  // No selection is null rather than "" — the column is nullable and "" is not
  // a valid key, so an empty string would fail the same foreign key.
  assert.equal(templateIdForCreate(""), null);
  assert.equal(templateIdForCreate(null), null);
  assert.equal(templateIdForCreate(undefined), null);
});

test("whether a selection is built-in is answered by the string, not by a loaded list", () => {
  // If this were answered by searching the built-ins array, a failed fetch
  // (offline, 500, an API without the route) would make every built-in
  // selection read as a template id and send it to the server. The question
  // must not depend on a network request having succeeded — so it is asked of
  // the selection alone, with no list passed in at all.
  assert.equal(isBuiltInSelection("whs:pre-start-daily"), true);
  assert.equal(builtInIdFromSelection("whs:pre-start-daily"), "pre-start-daily");

  // Control: a template id is not mistaken for a built-in, and the id survives
  // the round trip. A predicate that answered true for everything would pass
  // the two assertions above.
  assert.equal(isBuiltInSelection(USER_TEMPLATES[0].id), false);
  assert.equal(builtInIdFromSelection(USER_TEMPLATES[0].id), "");
  assert.equal(isBuiltInSelection(""), false);
  assert.equal(isBuiltInSelection(null), false);
  assert.equal(isBuiltInSelection(undefined), false);

  // And the namespace cannot collide with a uuid, which is what makes one
  // string safe to hold both kinds of selection.
  assert.match(BUILT_IN_PREFIX, /:/, "the prefix must contain a character uuid v4 cannot");
  assert.doesNotMatch(USER_TEMPLATES[0].id, /:/);
  assert.equal(builtInSelectionId("pre-start-daily"), "whs:pre-start-daily");
});

test("a selection resolves to its own items, and anything unresolvable falls back rather than to nothing", () => {
  assert.deepEqual(
    resolveChecklistItems(builtInSelectionId("pre-start-daily"), USER_TEMPLATES, BUILT_INS, FALLBACK),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    resolveChecklistItems(USER_TEMPLATES[0].id, USER_TEMPLATES, BUILT_INS, FALLBACK),
    ["p", "q"],
    "a company's own checklist must still resolve — the built-ins are an addition, not a replacement"
  );
  assert.deepEqual(resolveChecklistItems("", USER_TEMPLATES, BUILT_INS, FALLBACK), FALLBACK);

  // An inspection with zero items is a form that cannot be filled in, so every
  // unresolvable case falls back instead: a template deleted on another device,
  // a built-in id from a newer build than the API, and an entry that exists but
  // carries no items.
  assert.deepEqual(resolveChecklistItems("whs:not-a-real-checklist", USER_TEMPLATES, BUILT_INS, FALLBACK), FALLBACK);
  assert.deepEqual(resolveChecklistItems("deleted-on-another-device", USER_TEMPLATES, BUILT_INS, FALLBACK), FALLBACK);
  assert.deepEqual(resolveChecklistItems(builtInSelectionId("pre-start-daily"), USER_TEMPLATES, [], FALLBACK), FALLBACK);
  assert.deepEqual(
    resolveChecklistItems("whs:empty", USER_TEMPLATES, [{ id: "empty", name: "Empty", category: "x", items: [] }], FALLBACK),
    FALLBACK
  );

  // The returned array is a copy. The screen maps over it to build
  // `results: items.map(...)`, and the built-ins are module-level constants on
  // the API response — handing out the same array twice invites one screen's
  // edit to show up in the next inspection.
  const items = resolveChecklistItems(builtInSelectionId("swms-review"), USER_TEMPLATES, BUILT_INS, FALLBACK);
  items.push("mutated");
  assert.deepEqual(BUILT_INS[1].items, ["x", "y"], "resolveChecklistItems must not hand out its source array");
  assert.deepEqual(resolveChecklistItems("", USER_TEMPLATES, BUILT_INS, FALLBACK), FALLBACK);
});

test("only a built-in renames the inspection, because only a built-in is otherwise unrecorded", () => {
  // templateIdForCreate returns null for a built-in, so without the name the
  // inspection would carry no trace of which checklist produced it — on a
  // seven-year compliance record.
  assert.equal(
    suggestedInspectionName(builtInSelectionId("pre-start-daily"), BUILT_INS),
    "Daily Pre-Start Safety Checklist"
  );

  // Control: a user template's id IS stored on the row, so renaming after it
  // would overwrite a title the person chose in order to duplicate something
  // already recorded. "" means "leave what they typed alone".
  assert.equal(suggestedInspectionName(USER_TEMPLATES[0].id, BUILT_INS), "");
  assert.equal(suggestedInspectionName("", BUILT_INS), "");
  assert.equal(suggestedInspectionName(null, BUILT_INS), "");
  // An id the API does not serve suggests nothing rather than an empty title.
  assert.equal(suggestedInspectionName("whs:not-real", BUILT_INS), "");
});

// ─── The caller ──────────────────────────────────────────────────────────────
//
// Everything above tests the module. These two test that the SCREEN uses it,
// which is a different claim and the one that decides whether any of this is
// reachable: a guard no caller routes through is a guard that is not installed.
//
// Read off the .tsx source rather than exercised, because the node test program
// cannot compile a React Native screen — that is the same constraint that put
// this logic in a module in the first place (see the header of permissions.ts).
// A source-text assertion is weaker than running the screen, and the precedent
// for it in this package is screen-header-audit.test.ts. What it can prove is
// exactly the regression that would reintroduce the defect: somebody changing
// the POST body back to sending the picker's raw selection, which reads fine,
// passes typecheck, works in every in-memory API test, and 500s in production
// the first time a user picks a standard WHS checklist.

import fs from "node:fs";
import path from "node:path";

// __dirname is dist-test/lib at run time, so app/ is two levels up — the same
// arithmetic screen-header-audit.test.ts does, and for the same reason.
const SCREEN = path.resolve(__dirname, "..", "..", "app", "inspections", "[siteId].tsx");

function screenSource(): string {
  assert.ok(
    fs.existsSync(SCREEN),
    `the inspection screen was not found at ${SCREEN}. Every assertion below ` +
      `would pass over an empty string, so a renamed or moved screen must fail ` +
      `here rather than go quietly green.`
  );
  const src = fs.readFileSync(SCREEN, "utf8");
  // The positive control for the reader itself: a file that exists but reads
  // empty, or one this test has lost track of, must not satisfy the three
  // "does not contain" assertions below by virtue of containing nothing.
  assert.ok(src.length > 1000, `the screen source read as ${src.length} bytes`);
  assert.match(src, /apiJson/, "the screen does not call apiJson at all — this is not the file this test thinks it is");
  return src;
}

test("the inspection screen fetches the built-in checklists, so the route has a caller", () => {
  const src = screenSource();

  // The Block B claim, asserted rather than stated: GET /api/whs-checklists is
  // called from a shipping screen.
  assert.match(
    src,
    /apiJson<\{ checklists: WhsChecklist\[\] \}>\(`\/api\/whs-checklists`\)/,
    "the screen no longer fetches /api/whs-checklists — the route has no caller and the picker cannot show the built-ins"
  );
  // And the result reaches the picker. A fetch whose response is dropped is
  // the same as no fetch, and would leave whsChecklists empty — at which point
  // every built-in selection would resolve to DEFAULT_ITEMS and the only
  // symptom would be the wrong checklist silently appearing.
  assert.match(src, /setWhsChecklists\(/, "the fetched checklists are never stored, so the picker would render none of them");
  assert.match(src, /whsChecklists\.map\(/, "the stored checklists are never rendered, so the fetch is unobservable");
});

test("the screen sends templateId through the guard, and never the picker's raw selection", () => {
  const src = screenSource();

  // THE DEFECT THIS PREVENTS. `templateId: selectedTemplate || null` is what
  // the screen used to send, and it is what would send "pre-start-daily" into
  // a column declared REFERENCES inspection_templates(id).
  assert.doesNotMatch(
    src,
    /templateId:\s*selectedTemplate/,
    "the screen is sending the picker's raw selection as templateId again — a built-in checklist id would violate the inspections.template_id foreign key (23503, surfaced as a 500)"
  );
  // POSITIVE CONTROL for that negative: the screen must still send a templateId
  // at all, and it must come from the guard. Without this, deleting the field
  // entirely — which would silently stop recording which template was used —
  // passes the assertion above.
  assert.match(src, /templateIdForCreate\(selectedTemplate\)/, "templateId is no longer derived from templateIdForCreate");
  assert.match(src, /templateId,/, "the POST body no longer carries templateId at all");

  // The items and the name both route through the module too, for the same
  // reason: resolving a selection that addresses two populations is the part
  // that is tested, and a second copy of that logic in the screen would not be.
  assert.match(src, /resolveChecklistItems\(selectedTemplate/, "the screen resolves checklist items itself instead of through the tested module");
  assert.match(src, /suggestedInspectionName\(selectedTemplate/, "a built-in checklist no longer names the inspection, which is the only record that it was used");
});
