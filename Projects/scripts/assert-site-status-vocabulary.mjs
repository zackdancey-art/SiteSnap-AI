// Fails if the six independent declarations of a site's status vocabulary
// disagree, or if the two clients print different words for the same status.
//
// WHY THIS EXISTS
//
// One field, `project_sites.status`, is declared six times in three packages,
// and nothing in the toolchain connects any declaration to any other:
//
//   1. services/api/src/routes/projects.ts   SiteSchema's `z.enum([...])` — the
//                                            write gate, so it is the authority
//   2. services/api/src/storage/projectsStore.ts  `type SiteStatus`
//   3. services/api/src/storage/projectsStore.ts  the COUNT(*) FILTER literals
//                                            inside getPortfolioCounts
//   4. apps/mobile/lib/types.ts              `Site.status` union
//   5. apps/supervisor-web/lib/siteStatus.ts the portal's canonical set
//   6. apps/mobile/lib/siteStatus.ts         this surface's canonical set
//
// Declaration 6 is a twin of 5 rather than a shared module because
// `@sitesnap/shared` emits `.d.ts` only (`"main": "dist/index.d.ts"`), so it
// cannot carry a runtime constant, and the two clients are separate bundles
// with separate token files. There is no third place to put it. This check is
// what keeps the two copies honest; the comments in them are not.
//
// The portal's copy was wrong for the life of the feature. It keyed On Hold as
// `on_hold`, with an underscore, in two separately pasted config objects, and
// the API has always written `on-hold`. Three user-visible defects came out of
// that one character: an on-hold site rendered as grey "Inactive" on the
// dashboard, the Sites page's "On Hold" tab counted 0 forever, and selecting
// that tab returned an empty list — so the site was reachable only under "All".
//
// Nothing caught it, and it is worth being precise about why, because the
// reasons are all still true:
//
//   - `Site.status` in the portal is typed `string` (lib/api.ts), which is
//     honest about what the wire can carry and useless as a guard. Narrowing it
//     would be a claim about every row ever written, which is not a claim this
//     product can make — see the note on `inactive` below.
//   - The mobile client got it right (declaration 4 is a union, and both of its
//     screens compare against the hyphen), so the drift was invisible from
//     either end: each client was internally consistent.
//   - Nothing renders a site status in the API test suite, so no test had reason
//     to look at the string.
//
// WHAT IT ASSERTS
//
// Declaration 1 is the authority: no other status can be written. Declarations
// 2, 3 and 4 must equal it exactly. Declarations 5 and 6 must COVER it — each
// client is additionally allowed values it declares as fallbacks, because it
// must render whatever is already in the database, and the `inactive` key
// predates the zod enum. Those extras must be declared in the module's own
// fallback list, not merely present.
//
// AND THE LABELS, WHICH IS NEW
//
// 5 and 6 must also agree on the WORD shown for each status. They did not: a
// finished site read "Complete" on the portal and "Completed" on the phone, and
// the mobile dashboard printed `site.status.toUpperCase()`, so the same site was
// "ON-HOLD" there and "On Hold" everywhere else. Three renderings of one value,
// each internally consistent, which is why nothing noticed.
//
// Every status in this file is READ from a source file. There are no status
// literals in the comparison, so a renamed status fails the build instead of
// quietly matching a copy of the old name kept here.
//
// WHAT IT DOES NOT PROVE
//
//   - Nothing about rows ALREADY in the database. If some row carries a status
//     outside the enum, this check is silent and the portal's fallback is what
//     handles it. That is why the fallback exists and why it is permitted here.
//   - Nothing about the COLOURS each client shows. The labels are checked; the
//     colours are not, because the portal writes hex literals and mobile reads
//     design tokens, so there is no common form to compare. That agreement is
//     asserted instead from the mobile side, in
//     apps/mobile/lib/siteStatus.test.ts, which compares each token against the
//     portal's published hex.
//   - Nothing about any OTHER string either client shows for a status. Only the
//     one label map in each module is read.
//   - It reads source text, not the running code. A status assembled at runtime
//     (string concatenation, a value from an API response) is invisible to it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved against this script's own location, not the caller's cwd: ci.sh runs
// it from Projects/ and a developer runs it from the repo root, and a path that
// resolves in one and not the other is a check that fails for the wrong reason.
const PKGS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const fail = (m) => failures.push(m);
const read = (p) => {
  try {
    return readFileSync(resolve(PKGS, p), "utf8");
  } catch (err) {
    fail(`could not read ${p}: ${err.message}`);
    return null;
  }
};

const show = (set) => (set.size ? [...set].sort().map((s) => `"${s}"`).join(", ") : "(empty)");

/**
 * Pull the quoted strings out of one region of source. Every extractor below
 * returns null on a miss rather than an empty set: an empty set compares equal
 * to another empty set, which is how a check passes having read nothing. The
 * callers treat null as a hard failure and name the file.
 */
function quotedStrings(region) {
  const found = [...region.matchAll(/["'`]([^"'`\n]+)["'`]/g)].map((m) => m[1]);
  return found.length ? new Set(found) : null;
}

function regionAfter(src, anchor, closer) {
  const at = src.indexOf(anchor);
  if (at < 0) return null;
  const end = src.indexOf(closer, at + anchor.length);
  if (end < 0) return null;
  return src.slice(at + anchor.length, end);
}

// ── Reading the five declarations, per vocabulary ───────────────────────────

const routes = read("services/api/src/routes/projects.ts");
const store = read("services/api/src/storage/projectsStore.ts");
const mobile = read("apps/mobile/lib/types.ts");
const portal = read("apps/supervisor-web/lib/siteStatus.ts");
const mobileStatus = read("apps/mobile/lib/siteStatus.ts");

/** A `status: z.enum([...])` inside one named zod object schema. */
function zodStatusEnum(src, schemaName) {
  if (!src) return null;
  const schema = regionAfter(src, `const ${schemaName} = z.object({`, "});");
  const region = schema && regionAfter(schema, "status: z.enum([", "])");
  const set = region && quotedStrings(region);
  if (!set) {
    fail(
      `could not find ${schemaName}'s \`status: z.enum([...])\` in routes/projects.ts.\n` +
        "    This script has no fallback list to compare against, so it refuses to\n" +
        "    report a pass. If the schema moved or was renamed, update the anchor."
    );
  }
  return set;
}

/** A `type X = "a" | "b";` alias. */
function typeAlias(src, name, where) {
  if (!src) return null;
  const region = regionAfter(src, `type ${name} =`, ";");
  const set = region && quotedStrings(region);
  if (!set) fail(`could not find \`type ${name} = ...\` in ${where}.`);
  return set;
}

/** A `status:` property inside one named interface. */
function interfaceStatus(src, name, where) {
  if (!src) return null;
  const iface = regionAfter(src, `export interface ${name} {`, "\n}");
  const region = iface && regionAfter(iface, "status:", ";");
  const set = region && quotedStrings(region);
  if (!set) fail(`could not find \`${name}.status\` in ${where}.`);
  return set;
}

/**
 * The `FILTER (WHERE status = '...')` literals of the one statement that reads
 * `table`, inside `fnName`.
 *
 * Scoped to a single statement on purpose. getPortfolioCounts issues three
 * queries against three tables, and project_sites and project_diaries each have
 * their own `status` vocabulary — reading the whole function body collects both
 * and compares the union against one enum. (That is not hypothetical: the first
 * version of this script did exactly that, and reported `"approved"` as an
 * extra site status.)
 */
function sqlStatusLiterals(src, fnName, table) {
  if (!src) return null;
  const fn = regionAfter(src, `export async function ${fnName}`, "\n}");
  if (fn === null) {
    fail(`could not find ${fnName} in storage/projectsStore.ts.`);
    return null;
  }
  const at = fn.indexOf(`FROM ${table}`);
  if (at < 0) {
    fail(
      `${fnName} issues no query against ${table}.\n` +
        "    If the breakdown moved to another table, a GROUP BY or a shared\n" +
        "    constant, delete this extractor in the same commit — do not leave it\n" +
        "    passing vacuously."
    );
    return null;
  }
  // Back to the start of this statement: the previous SELECT before the FROM.
  const start = fn.lastIndexOf("SELECT", at);
  const statement = fn.slice(start < 0 ? 0 : start, at);
  const literals = [...statement.matchAll(/FILTER\s*\(\s*WHERE\s+status\s*=\s*'([^']+)'\s*\)/gi)].map((m) => m[1]);
  if (!literals.length) {
    fail(
      `found no \`FILTER (WHERE status = '...')\` literals in ${fnName}'s ${table} query.\n` +
        "    These are hand-written status literals in a SQL predicate, which is the\n" +
        "    exact shape of a defect this repo has already shipped (a deleted_at\n" +
        "    predicate on a table with no such column, so site progress had never\n" +
        "    once worked). A renamed status leaves the count reporting 0, which is\n" +
        "    indistinguishable from a company that has none."
    );
    return null;
  }
  return new Set(literals);
}

const diff = (a, b) => [...a].filter((x) => !b.has(x));

/**
 * `set` must equal `authority` exactly. Anything that can WRITE or COUNT a
 * status has to agree with the write gate in both directions: a value it cannot
 * write is dead code, and one it can write but does not know is a silent
 * mis-render.
 */
function assertExact(label, authority, set) {
  if (!authority || !set) return;
  const missing = diff(authority, set);
  const extra = diff(set, authority);
  if (missing.length || extra.length) {
    fail(
      `${label} does not match the enum.\n` +
        `    enum:  ${show(authority)}\n` +
        `    there: ${show(set)}` +
        (missing.length ? `\n    missing: ${missing.map((x) => `"${x}"`).join(", ")}` : "") +
        (extra.length ? `\n    extra:   ${extra.map((x) => `"${x}"`).join(", ")}` : "")
    );
  }
}

// ── Site status ─────────────────────────────────────────────────────────────

const siteEnum = zodStatusEnum(routes, "SiteSchema");

assertExact("storage/projectsStore.ts `type SiteStatus`", siteEnum, typeAlias(store, "SiteStatus", "storage/projectsStore.ts"));
assertExact(
  "storage/projectsStore.ts getPortfolioCounts' project_sites FILTER literals",
  siteEnum,
  sqlStatusLiterals(store, "getPortfolioCounts", "project_sites")
);
assertExact("apps/mobile/lib/types.ts `Site.status`", siteEnum, interfaceStatus(mobile, "Site", "apps/mobile/lib/types.ts"));

// The two clients are the declarations allowed to be WIDER than the enum, and
// only where they say so. Each must render whatever is already in the database,
// and the `inactive` key predates the zod enum.

/**
 * One client's status vocabulary and its label map.
 *
 * The vocabulary is the RIGHT-hand side of the alias map: the left is
 * deliberately wider (it is where `on_hold` is still accepted, in case a row
 * carries the old spelling), so reading the left would make this check pass on
 * exactly the defect it exists to catch.
 */
function clientVocabulary(src, where) {
  if (!src) return null;

  const aliases = regionAfter(src, "const ALIASES:", "});");
  const values = aliases && [...aliases.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  const set = values && values.length ? new Set(values) : null;
  if (!set) fail(`could not find the ALIASES map in ${where}.`);

  // The LEFT-hand side as well — the spellings this client will accept from a
  // row or a cache. Kept separate from `set` because the two answer different
  // questions, and conflating them is how the first version of the
  // client-vs-client check passed while one client quietly stopped recognising
  // the `on_hold` spelling the other still handled.
  const spellings = aliases && [...aliases.matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]);
  const accepts = spellings && spellings.length ? new Set(spellings) : null;
  if (!accepts) fail(`could not read the accepted spellings (ALIASES keys) in ${where}.`);

  const unknown = regionAfter(src, "const UNKNOWN: SiteStatusKey =", ";");
  const fallbacks = unknown && quotedStrings(unknown);
  if (!fallbacks) {
    fail(
      `could not find the declared fallback (\`const UNKNOWN\`) in ${where}.\n` +
        "    A client is allowed statuses the API cannot write only where it says so."
    );
  }

  // key -> label, from the one config map. The key may be bare (`active:`) or
  // quoted (`"on-hold":`), since the hyphen forces quoting on exactly the entry
  // this check most needs to read.
  const cfg = regionAfter(src, "const SITE_STATUS_CFG", "});");
  const pairs = cfg && [...cfg.matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{\s*label:\s*"([^"]+)"/g)];
  const labels = pairs && pairs.length ? new Map(pairs.map((m) => [m[1] ?? m[2], m[3]])) : null;
  if (!labels) {
    fail(
      `could not find the SITE_STATUS_CFG label map in ${where}.\n` +
        "    Without it the two surfaces' words are unchecked, which is the state\n" +
        "    that shipped \"Complete\" on one and \"Completed\" on the other."
    );
  }

  return { set, accepts, fallbacks, labels };
}

/** Each client must cover the enum, and over-declare only what it names. */
function assertCovers(where, authority, v) {
  if (!authority || !v || !v.set || !v.fallbacks) return;
  const uncovered = diff(authority, v.set);
  if (uncovered.length) {
    fail(
      `${where} cannot render every status the API\n` +
        `    can write. Uncovered: ${uncovered.map((x) => `"${x}"`).join(", ")}\n` +
        `    enum:   ${show(authority)}\n` +
        `    client: ${show(v.set)}\n` +
        "    A status the client does not know falls through to its unknown-status\n" +
        "    fallback, so it renders under the wrong label and its filter tab counts\n" +
        "    zero of it. That is the defect this check was written for."
    );
  }
  const undeclared = diff(v.set, authority).filter((x) => !v.fallbacks.has(x));
  if (undeclared.length) {
    fail(
      `${where} declares statuses the API cannot write\n` +
        `    and does not list as fallbacks: ${undeclared.map((x) => `"${x}"`).join(", ")}\n` +
        "    Either add it to the enum or mark it as the fallback."
    );
  }
}

const portalV = clientVocabulary(portal, "apps/supervisor-web/lib/siteStatus.ts");
const mobileV = clientVocabulary(mobileStatus, "apps/mobile/lib/siteStatus.ts");

assertCovers("apps/supervisor-web/lib/siteStatus.ts", siteEnum, portalV);
assertCovers("apps/mobile/lib/siteStatus.ts", siteEnum, mobileV);

// The two clients against each other: same accepted spellings, same keys, and
// the same word for each key. This is the check that was missing.
if (portalV && mobileV) {
  // Two comparisons, not one. The canonical set is what each client reduces a
  // status TO; the accepted spellings are what it will reduce FROM. A client can
  // match on the first and still fail to recognise a spelling the other handles,
  // which renders the same row differently on the two surfaces — the whole
  // problem this file exists for.
  const compare = (what, a, b) => {
    if (!a || !b) return;
    const onlyPortal = diff(a, b);
    const onlyMobile = diff(b, a);
    if (onlyPortal.length || onlyMobile.length) {
      fail(
        `the two clients do not agree on ${what}.\n` +
          `    portal: ${show(a)}\n` +
          `    mobile: ${show(b)}` +
          (onlyPortal.length ? `\n    portal only: ${onlyPortal.map((x) => `"${x}"`).join(", ")}` : "") +
          (onlyMobile.length ? `\n    mobile only: ${onlyMobile.map((x) => `"${x}"`).join(", ")}` : "") +
          "\n    A row written once is then read two ways."
      );
    }
  };

  compare("the statuses they reduce TO", portalV.set, mobileV.set);
  compare("the spellings they accept", portalV.accepts, mobileV.accepts);

  if (portalV.labels && mobileV.labels) {
    const keys = new Set([...portalV.labels.keys(), ...mobileV.labels.keys()]);
    for (const key of [...keys].sort()) {
      const a = portalV.labels.get(key);
      const b = mobileV.labels.get(key);
      if (a === undefined || b === undefined) {
        fail(
          `only one client has a label for "${key}".\n` +
            `    portal: ${a === undefined ? "(none)" : `"${a}"`}\n` +
            `    mobile: ${b === undefined ? "(none)" : `"${b}"`}\n` +
            "    A key with no config renders as undefined on that surface."
        );
      } else if (a !== b) {
        fail(
          `the two clients print different words for "${key}".\n` +
            `    portal: "${a}"\n` +
            `    mobile: "${b}"\n` +
            "    Pick one and change both. This is the Complete/Completed defect."
        );
      }
    }
  }
}

const portalSet = portalV && portalV.set;
const portalFallbacks = portalV && portalV.fallbacks;

// ── Diary status ────────────────────────────────────────────────────────────
//
// Included because getPortfolioCounts counts diaries by status with the same
// kind of hand-written SQL literal, and `approvedDiaries` feeds a red/amber/
// green approval-rate bar. A drifted literal there reports 0% approved to a
// company whose diaries are all approved, which reads as a compliance problem
// rather than as a bug.
//
// The portal is NOT checked for this one: it has no single diary-status module,
// it compares `d.status === "approved"` inline in five files. Consolidating
// those is a separate change, and claiming coverage the check does not have is
// how the last green check came to mean nothing.

const diaryEnum = zodStatusEnum(routes, "DiarySchema");

assertExact("routes/projects.ts DiaryPatchSchema's enum", diaryEnum, zodStatusEnum(routes, "DiaryPatchSchema"));
assertExact("storage/projectsStore.ts `type DiaryStatus`", diaryEnum, typeAlias(store, "DiaryStatus", "storage/projectsStore.ts"));
assertExact(
  "apps/mobile/lib/types.ts `GeneratedDiary.status`",
  diaryEnum,
  interfaceStatus(mobile, "GeneratedDiary", "apps/mobile/lib/types.ts")
);

// The diary FILTER literals, as a subset: every literal must be a real status,
// but the query need not mention all of them.
const diarySql = sqlStatusLiterals(store, "getPortfolioCounts", "project_diaries");
if (diaryEnum && diarySql) {
  const bogus = diff(diarySql, diaryEnum);
  if (bogus.length) {
    fail(
      "storage/projectsStore.ts getPortfolioCounts counts diary statuses that\n" +
        `    DiarySchema cannot write: ${bogus.map((x) => `"${x}"`).join(", ")}\n` +
        `    enum: ${show(diaryEnum)}\n` +
        "    A FILTER on a status that cannot exist counts 0 of it, forever, and\n" +
        "    reads as an empty company rather than as a broken predicate."
    );
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error("assert-site-status-vocabulary: FAIL\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error("  One field, six declarations, no compiler link between them.");
  process.exit(1);
}

console.log(`  site status:  ${show(siteEnum)} — all 6 declarations agree.`);
if (portalV && portalV.labels) {
  const words = [...portalV.labels.entries()].sort().map(([k, v]) => `${k}→"${v}"`).join(", ");
  console.log(`  labels, identical on both clients: ${words}`);
}
console.log(`  diary status: ${show(diaryEnum)} — all 4 API/mobile declarations agree.`);
console.log(`  portal fallback, not writable by the API: ${show(portalFallbacks)}`);
