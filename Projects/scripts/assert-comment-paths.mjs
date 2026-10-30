#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A COMMENT THAT NAMES A FILE MUST NAME A FILE THAT EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS, WHICH IS NOT A STYLE REASON
 *
 * Three false comments caused three real gaps in one week:
 *
 *   1. `app-config-permissions.test.ts` named a guard that does not exist, so
 *      the guard was believed to be covered and was not. (The test file does
 *      not exist either, which is why it is named here without a path: the
 *      shape this check looks for is a path, and writing one would make this
 *      very comment an instance of the problem.)
 *   2. `useRole.ts`'s isAtLeast line described behaviour the function does
 *      not have.
 *   3. scripts/ci.sh said "the portal, which has no test harness", which is
 *      what kept apps/supervisor-web/scripts/run-tests.sh out of the AUDIT
 *      L110 and L115 sweeps — two holes left open by a sentence in a comment.
 *
 * Two of the three were a path that a machine could have checked. This checks
 * those. A comment is read as documentation by the next person, and a path
 * that silently rots is documentation that points at nothing while reading as
 * though it points at something.
 *
 * WHAT THIS CANNOT SEE, AND IT IS THE LARGER HALF
 *
 * Item 2 above. A comment asserting a BEHAVIOUR — "this is gated at manager+",
 * "both routes trim on the way in" — is unverifiable by any amount of path
 * resolution, and that is the class of false comment that has done the most
 * damage. This check buys the cheap half and makes no claim on the rest.
 *
 * It also cannot see: a path that exists but is the WRONG file; a bare
 * filename with no slash (`types.ts`), which is ambiguous across packages and
 * deliberately not guessed at; a path inside a template literal or a string,
 * because that is code and the compiler has an opinion about it already; and
 * anything containing a glob, which is counted and reported separately rather
 * than silently dropped.
 *
 * REPORTS THE POPULATION, NOT ONLY THE FAILURES. A check that prints nothing
 * when it finds nothing is indistinguishable from a check whose file walk is
 * broken, which is AUDIT L112's whole subject. The counts print on every run.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PROJECTS, "..");

/** Directories never walked: generated, vendored, or not ours. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-test", ".next", ".expo", ".turbo",
  "coverage", "build", "ios", "android", ".vercel",
]);

/** The file types whose comments are read. */
const SCANNED = /\.(ts|tsx|sql|sh|mjs|js|jsx)$/;

/**
 * The file types a comment may POINT AT. Deliberately the four the brief
 * named, plus .mjs because this directory is full of them and a check that
 * could not verify a reference to its own siblings would be odd.
 */
const TARGET_EXT = /\.(ts|tsx|sql|sh|mjs)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (SCANNED.test(name)) out.push(full);
  }
  return out;
}

/**
 * The comment text of one file, as { line, text } pairs.
 *
 * Crude on purpose. A `//` inside a string literal — `"https://x"` — would be
 * read as a comment, which is why the candidate regex below requires a path
 * shape and why a URL is excluded explicitly. The alternative is a parser per
 * language, and three of the five languages here do not have one to hand.
 */
function comments(source, file) {
  const out = [];
  const lines = source.split("\n");
  const sql = file.endsWith(".sql");
  const sh = file.endsWith(".sh");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const push = (text) => out.push({ line: i + 1, text });
    if (inBlock) {
      const end = line.indexOf("*/");
      push(end === -1 ? line : line.slice(0, end));
      if (end !== -1) inBlock = false;
      continue;
    }
    if (sh) {
      const h = line.indexOf("#");
      if (h !== -1) push(line.slice(h + 1));
      continue;
    }
    if (sql) {
      const d = line.indexOf("--");
      if (d !== -1) push(line.slice(d + 2));
      const b = line.indexOf("/*");
      if (b !== -1) { push(line.slice(b + 2)); if (line.indexOf("*/", b) === -1) inBlock = true; }
      continue;
    }
    const b = line.indexOf("/*");
    const s = line.indexOf("//");
    if (b !== -1 && (s === -1 || b < s)) {
      const end = line.indexOf("*/", b + 2);
      push(end === -1 ? line.slice(b + 2) : line.slice(b + 2, end));
      if (end === -1) inBlock = true;
    } else if (s !== -1) {
      push(line.slice(s + 2));
    }
  }
  return out;
}

/**
 * Something that looks like a repo-relative path to a source file.
 *
 * A SLASH IS REQUIRED. `types.ts` names one of four files called that and
 * guessing which would turn this check into a source of false failures, which
 * is worse than no check — a check people learn to override is a check that is
 * off. Trailing `:123` line references are stripped; the brief is paths.
 */
const CANDIDATE = /(?:^|[\s(['"`,=])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.(?:tsx|ts|sql|sh|mjs))(?![A-Za-z0-9_])(?::\d+(?:-\d+)?)?/g;

/**
 * `tsx` BEFORE `ts`, and the boundary after the group, both learned the hard
 * way: the first version of this regex read `clients.tsx` as
 * `clients.ts` — alternation is ordered and nothing anchored the end — and
 * then reported 343 failures, almost every one of them its own. A structural
 * check that cries wolf gets switched off, so the false-positive rate is the
 * thing that decides whether this is worth having.
 *
 * `.d.ts` is excluded below rather than here. A declaration file is build
 * output; `@sitesnap/shared`'s `dist/index.d.ts` is referred to in six places
 * and exists only after a build, so demanding it be on disk would make this
 * check order-dependent on whether someone has run `build:types`.
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE POPULATION IS DERIVED, NOT PINNED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * AUDIT L112: where a population is knowable, pin it with an equality or
 * derive it at run time. 407 files is knowable but it moves on every commit,
 * so a literal here would be stale within the day and then raised without
 * thought — which is a floor wearing an equality's clothes.
 *
 * So it is derived instead, from `git ls-files`, and the two sets must match.
 * That makes a broken walk fail LOUDLY and for the right reason. It was
 * found by measurement: breaking the `SCANNED` pattern was tried as a
 * negative control, and the check did fail — but by way of the KNOWN_ABSENT
 * reverse pin, reporting five unused exemptions and saying nothing about
 * having examined nothing. A check that fails for the wrong reason tells the
 * next person to go and look in the wrong place.
 *
 * `git ls-files` rather than a second walk, deliberately: a second walk with
 * the same bug agrees with the first. Git's index is an independent authority
 * and it also means an unstaged new file is not silently excluded from the
 * sweep — it is reported as a disagreement.
 *
 * AND THE TWO SIDES MUST NOT SHARE THEIR DEFINITION OF THE POPULATION, which
 * is the mistake the first version of this block made and which the same
 * negative control caught a second time. It filtered the git listing through
 * `SCANNED` and `SKIP_DIRS` — the walk's own constants — so breaking either
 * shrank BOTH sets identically and the comparison reported "0 file(s) walked,
 * agreeing exactly with git ls-files". A comparison between two things
 * computed from one definition is a comparison with itself.
 *
 * So the two literals below are a deliberate duplicate of `SCANNED` and
 * `SKIP_DIRS`, not an oversight to be tidied into a shared constant. The
 * duplication IS the check: whichever copy is edited, the other disagrees and
 * names the files. If you are here to de-duplicate them, the thing you would
 * be removing is the only reason this block can fail.
 */

/** Deliberate duplicate of `SCANNED` — see above. Do not share the constant. */
const GIT_SIDE_SCANNED = /\.(ts|tsx|sql|sh|mjs|js|jsx)$/;
/** Deliberate duplicate of `SKIP_DIRS` — see above. Do not share the constant. */
const GIT_SIDE_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-test", ".next", ".expo", ".turbo",
  "coverage", "build", "ios", "android", ".vercel",
]);
function gitTracked() {
  // `--cached --others --exclude-standard`: everything git considers part of
  // the repo, which includes a new file nobody has staged yet and excludes
  // everything .gitignore does. Plain `ls-files` lists only the index, and
  // measured against this branch that reported six disagreements that were
  // simply this PR's own new files — a check that fails on untracked work in
  // progress is a check people run with `|| true`.
  const out = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "Projects", ".github"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const files = walk(PROJECTS).concat(
  // The root-level documents and workflows are scanned too: ci.yml and
  // CLAUDE.md are where a stale path misleads the most people.
  existsSync(join(REPO, ".github")) ? walk(join(REPO, ".github")) : []
);

/**
 * The two sets, compared. A file git knows about that the walk missed is as
 * much a failure as the reverse: the first means the sweep is not covering
 * what it claims, the second that it is reading something generated.
 */
{
  const walked = new Set(files.map((f) => f.slice(REPO.length + 1)));
  const tracked = new Set(
    gitTracked().filter((f) => {
      if (!GIT_SIDE_SCANNED.test(f)) return false;
      return !f.split("/").some((seg) => GIT_SIDE_SKIP_DIRS.has(seg));
    })
  );
  const missed = [...tracked].filter((f) => !walked.has(f));
  const extra = [...walked].filter((f) => !tracked.has(f));
  if (missed.length > 0 || extra.length > 0) {
    console.error(`FAIL: the file walk and git disagree — ${missed.length} tracked file(s) not walked, ${extra.length} walked file(s) not tracked.`);
    for (const f of missed.slice(0, 20)) console.error(`  not walked: ${f}`);
    for (const f of extra.slice(0, 20)) console.error(`  not tracked: ${f}`);
    console.error("");
    console.error("  A file git tracks that this walk missed means the sweep is smaller");
    console.error("  than it reports. A walked file git does not track is either");
    console.error("  generated output or a new file nobody has staged — stage it, or");
    console.error("  add its directory to SKIP_DIRS.");
    process.exit(1);
  }
  console.log(`  comment-paths: ${walked.size} file(s) walked, agreeing exactly with git ls-files.`);
}

let refs = 0;
let globbed = 0;
let urlish = 0;
let declarations = 0;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT "POINTS AT A FILE THAT EXISTS" MEANS, PRECISELY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO RULES, and the second is the interesting one.
 *
 * 1. EXACT, against every ancestor directory of the commenting file up to the
 *    repo root. A comment is written relative to whatever scope its author had
 *    in their head, and in this tree that is variously the repo
 *    (`Projects/scripts/ci.sh`), the pnpm workspace
 *    (`apps/mobile/lib/types.ts`), the package (`lib/api.ts`) or the file's
 *    own directory. Walking the ancestors covers all of them without
 *    enumerating which convention each package follows.
 *
 * 2. SUFFIX, within the commenting file's own package only. The API writes
 *    `storage/tenant.ts` and `migrations/009_v2_features.sql`, both relative
 *    to `src/` — which is not an ancestor of a file in `src/routes/`, so rule
 *    1 misses them. Rule 2 asks instead: does any file in THIS package have
 *    that trailing path? 148 of the API's references are of this shape.
 *
 *    Rule 2 is deliberately NOT repo-wide, and that is the whole reason this
 *    check still catches anything. `apps/supervisor-web/lib/annotation-
 *    render.ts` refers to `components/AnnotatedImage.tsx`, which exists — in
 *    the MOBILE package. Repo-wide suffix matching would resolve it and the
 *    check would pass on the one comment it was written to catch. Scoped to
 *    the package, it fails, correctly: the portal has never had that file.
 *
 * SO WHAT RULE 2 CANNOT SEE: two files with the same trailing path inside one
 * package. `storage/clientsStore.ts` would be satisfied by a second file at
 * the same trailing path under some other directory. Within a package that is
 * a naming collision somebody would have to have gone out of their way to
 * create, and the alternative — per-package root configuration — is a list
 * that goes stale, which is the failure mode this whole check is about.
 */
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  REFERENCES THAT ARE DELIBERATELY NOT ON DISK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five, each with its reason. Three kinds, and none of them is rot:
 *
 *   - A DEPENDENCY'S OWN SOURCE. Real files, inside node_modules, which this
 *     walk skips. The comments cite them as evidence — a library's actual
 *     implementation of a component — and the citation is the valuable part.
 *   - A FILE DELIBERATELY REMOVED, named in the past tense. The portal's
 *     fourth copies of the legal documents are the subject of AUDIT A6, and
 *     the comments exist to say they are gone and why. The brief's own
 *     instruction — "if a path is genuinely historical, say so in words" — is
 *     satisfied by those comments, and a reader can tell; a path resolver
 *     cannot read tense. This is the one part of this check that needs a human
 *     decision per entry, and so it is written down per entry.
 *   - A FILE DELIBERATELY NEVER CREATED, named to say why not.
 *
 * PINNED BOTH WAYS. An entry still listed here that nothing references any
 * more is a failure, not a quiet no-op — otherwise this list becomes the place
 * exemptions accumulate, and a growing allowlist is how a check stops
 * checking. Adding an entry means writing the reason, and a reviewer reads it.
 */
const KNOWN_ABSENT = new Map([
  ["src/components/GestureHandlerRootView.tsx",
   "react-native-gesture-handler's own source, cited for its flex:1 default."],
  ["views/NativeStackView.native.tsx",
   "@react-navigation/native-stack's own source, cited for its pop dispatch."],
  ["app/privacy/page.tsx",
   "Removed. The portal's fourth copy of the privacy policy; AUDIT A6."],
  ["app/terms/page.tsx",
   "Removed. The portal's fourth copy of the terms; AUDIT A6."],
  ["app/clients/page.tsx",
   "Never created — next.config.mjs explains why a redirect page does not work."],
]);

let allowed = 0;
const unusedAllowances = new Set(KNOWN_ABSENT.keys());

const pkgFileCache = new Map();

function packageRoot(file) {
  let d = dirname(file);
  while (d !== REPO && d !== "/") {
    if (existsSync(join(d, "package.json"))) return d;
    d = dirname(d);
  }
  return null;
}

function packageFiles(root) {
  let listed = pkgFileCache.get(root);
  if (!listed) {
    listed = [];
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      let names;
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) stack.push(full);
        else listed.push(full);
      }
    }
    pkgFileCache.set(root, listed);
  }
  return listed;
}

function resolves(file, raw) {
  const rel = raw.replace(/^\.{1,2}\//, "");
  // Rule 1: exact, against every ancestor.
  let dir = dirname(file);
  for (;;) {
    if (existsSync(resolve(dir, rel))) return true;
    if (dir === REPO || dir === "/") break;
    dir = dirname(dir);
  }
  // Rule 2: suffix, inside this file's own package.
  const root = packageRoot(file);
  if (root) {
    const needle = "/" + rel;
    if (packageFiles(root).some((f) => f.endsWith(needle))) return true;
  }
  return false;
}
const unique = new Set();
const failures = [];

for (const file of files) {
  let source;
  try { source = readFileSync(file, "utf8"); } catch { continue; }
  if (!source.includes("/")) continue;
  for (const { line, text } of comments(source, file)) {
    for (const m of text.matchAll(CANDIDATE)) {
      const raw = m[1];
      if (!TARGET_EXT.test(raw)) continue;
      // A URL is not a repo path. `//` inside a string is the main way one
      // reaches this function at all.
      if (/^https?:/.test(text.slice(0, Math.max(0, m.index))) && text.slice(0, m.index).includes("://")) { urlish++; continue; }
      if (raw.includes("*")) { globbed++; continue; }
      if (/\.d\.ts$/.test(raw)) { declarations++; continue; }
      refs++;
      unique.add(raw);
      if (resolves(file, raw)) continue;
      if (KNOWN_ABSENT.has(raw)) {
        allowed++;
        unusedAllowances.delete(raw);
        continue;
      }
      failures.push({ file: file.slice(REPO.length + 1), line, raw });
    }
  }
}

console.log(`  comment-paths: ${files.length} file(s) scanned, ${refs} path reference(s) in comments (${unique.size} distinct).`);
console.log(`  comment-paths: ${globbed} glob(s), ${urlish} URL-like and ${declarations} .d.ts match(es) skipped — this check does not resolve those.`);

console.log(`  comment-paths: ${allowed} reference(s) to a declared-absent path allowed, from a list of ${KNOWN_ABSENT.size}.`);

if (unusedAllowances.size > 0) {
  console.error("");
  console.error(`FAIL: ${unusedAllowances.size} KNOWN_ABSENT entr(y/ies) are referenced by no comment.`);
  for (const k of unusedAllowances) console.error(`  ${k} — ${KNOWN_ABSENT.get(k)}`);
  console.error("");
  console.error("  The comment that needed the exemption is gone, so the exemption");
  console.error("  should go with it. Delete the entry.");
  process.exit(1);
}

if (failures.length > 0) {
  console.error("");
  console.error(`FAIL: ${failures.length} comment(s) name a source file that does not exist.`);
  for (const f of failures) console.error(`  ${f.file}:${f.line} → ${f.raw}`);
  console.error("");
  console.error("  Fix the COMMENT, or fix the code it describes. A path that points at");
  console.error("  nothing has, three times this week, been read as evidence that");
  console.error("  something was covered when it was not (AUDIT L117, L120).");
  console.error("  If a path is genuinely historical, say so in words rather than");
  console.error("  leaving it looking like a live reference.");
  process.exit(1);
}

console.log(`  comment-paths: every one resolves.`);
