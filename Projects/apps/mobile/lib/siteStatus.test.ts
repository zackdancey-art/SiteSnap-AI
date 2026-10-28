import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SITE_STATUS_CFG,
  canonicalSiteStatus,
  siteStatusCfg,
  siteStatusLabel,
} from "./siteStatus";

/**
 * WHY THESE TESTS EXIST
 *
 * Mobile cannot be screenshotted from this environment, so the only way to
 * check what word and what colour a status renders as is to assert on the
 * function that decides it. That is also why the decision was moved out of the
 * two screens that each held their own copy of it.
 *
 * The specific defect: app/(tabs)/index.tsx showed a finished site as
 * "Completed" in Colors.textTertiary — grey, the same grey it uses for a status
 * it does not recognise — while every portal surface shows "Complete" in accent
 * orange. app/supervisor-dashboard.tsx printed `site.status.toUpperCase()`, so
 * the same site read "ON-HOLD" there and "On Hold" on the portal. Three
 * renderings of one value.
 */

test("the labels are the portal's words, not this surface's old ones", () => {
  // The two that were actually wrong, named explicitly rather than looped, so
  // the failure message says which word changed.
  assert.equal(siteStatusLabel("completed"), "Complete");
  assert.equal(siteStatusLabel("on-hold"), "On Hold");

  // And the two that were already right, so this is not a test that would pass
  // against a map containing nothing but those two keys.
  assert.equal(siteStatusLabel("active"), "Active");
  assert.equal(siteStatusLabel("inactive"), "Inactive");

  // The old renderings, asserted as absent. On their own these are vacuous —
  // they pass equally well if the function returns "" — which is what the four
  // positive assertions above are for.
  assert.notEqual(siteStatusLabel("completed"), "Completed");
  assert.notEqual(siteStatusLabel("on-hold"), "ON-HOLD");
});

test("the colours are the same values the portal publishes", () => {
  /**
   * The right-hand sides are copied from apps/supervisor-web/lib/siteStatus.ts
   * as literals ON PURPOSE. Comparing mobile's tokens against mobile's tokens
   * would assert nothing; comparing them against the portal's published hexes
   * is the agreement that matters, and a literal is the only way to state it
   * from this side of the workspace — the mobile test program cannot import
   * from another package.
   *
   * If a token moves, this test fails and names the colour. That is the point:
   * the two surfaces are then visibly out of step and someone decides, rather
   * than one of them quietly drifting.
   */
  assert.equal(SITE_STATUS_CFG.active.color, "#22C55E");
  assert.equal(SITE_STATUS_CFG.completed.color, "#E8731A");
  assert.equal(SITE_STATUS_CFG["on-hold"].color, "#F59E0B");
  assert.equal(SITE_STATUS_CFG.inactive.color, "#9EAFC2");

  // The defect was not only the word. A finished site was grey — the
  // unrecognised-status colour — so it looked like a site the app could not
  // read. Stated as its own assertion because it is its own bug.
  assert.notEqual(SITE_STATUS_CFG.completed.color, SITE_STATUS_CFG.inactive.color);
});

test("the spellings the product has shipped all resolve, and anything else reads as Inactive", () => {
  // The API's enum.
  assert.equal(canonicalSiteStatus("active"), "active");
  assert.equal(canonicalSiteStatus("completed"), "completed");
  assert.equal(canonicalSiteStatus("on-hold"), "on-hold");

  // Spellings a cached or older row can carry. `on_hold` is the one that
  // mattered: the portal compared against that literal for the life of the
  // product, and a tab tallying it always read 0.
  assert.equal(canonicalSiteStatus("on_hold"), "on-hold");
  assert.equal(canonicalSiteStatus("onhold"), "on-hold");
  assert.equal(canonicalSiteStatus("complete"), "completed");

  // Case and whitespace, because AsyncStorage is rehydrated by a cast and not a
  // parse, so the string is whatever some past build wrote.
  assert.equal(canonicalSiteStatus("  On-Hold "), "on-hold");
  assert.equal(canonicalSiteStatus("ACTIVE"), "active");

  // The fallback. Not a throw, and not the first key of the map.
  assert.equal(canonicalSiteStatus("archived"), "inactive");
  assert.equal(canonicalSiteStatus(""), "inactive");
  assert.equal(canonicalSiteStatus(null), "inactive");
  assert.equal(canonicalSiteStatus(undefined), "inactive");
});

test("every status resolves to a config, so no screen can render undefined", () => {
  // `site.status` is typed as a three-member union but arrives from a cast, so
  // the reading has to be total. A missing config would render the word
  // "undefined" in a badge; this is the assertion that says it cannot.
  for (const raw of ["active", "completed", "on-hold", "on_hold", "archived", "", "  ", "???"]) {
    const cfg = siteStatusCfg(raw);
    assert.ok(cfg, `no config for ${JSON.stringify(raw)}`);
    assert.equal(typeof cfg.label, "string");
    assert.ok(cfg.label.length > 0, `empty label for ${JSON.stringify(raw)}`);
    assert.match(cfg.color, /^#[0-9A-Fa-f]{6}$/);
  }

  // And the map is frozen, so a screen cannot patch a label at runtime and
  // leave the other surface behind.
  assert.ok(Object.isFrozen(SITE_STATUS_CFG));
});
