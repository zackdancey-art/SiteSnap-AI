// Anchored to this file's own directory so `parserOptions.project` paths resolve
// against the workspace root (Projects/) no matter what cwd ESLint runs from.
// Without this, `tsconfigRootDir` defaults to cwd, and when `next lint` runs from
// apps/supervisor-web the workspace-relative project paths DOUBLE
// (…/apps/supervisor-web/apps/supervisor-web/tsconfig.json → "Cannot read file").
// This is finding H5. Keep as .js (not .json) so `__dirname` is available.
const tsconfigRootDir = __dirname;

// ── The soft-delete column name is banned from SQL text ───────────────────
//
// AUDIT L99: `updateSiteProgress` carried `deleted_at IS NULL` against
// `project_sites`, which has no such column. Every call against Postgres failed
// with `column "deleted_at" does not exist`, so site progress had never once
// worked in production, and nothing in the repo noticed for months. The author
// of that predicate did not forget to check -- they believed the column was
// there, because four sibling tables do have it.
//
// That is not a class of mistake a comment prevents. So the column name is
// allowed to appear in SQL text in exactly one module, `storage/softDelete.ts`,
// which pairs it with the explicit list of tables that have it and returns the
// predicate through a function whose parameter type makes a wrong table a
// COMPILE error. Everywhere else, writing the string is a lint error.
//
// Scope, deliberately narrow and deliberately dumb: string literals and
// template-literal text only. `row.deleted_at`, a row-type property, and a
// `deletedAt` field name are Identifiers, not Literals, so they are untouched --
// the mappers that read the column still read it by name, which is correct.
// What cannot be written is SQL, because SQL is a string.
//
// This is a text rule, so it is evadable: `"deleted" + "_at"` passes. That is
// accepted. The rule is not a sandbox, it is a tripwire on the exact shape the
// defect took, and a contributor assembling the column name from fragments to
// get around a lint error is a different conversation from one who simply did
// not know.
const SOFT_DELETE_COLUMN_BAN_MESSAGE =
  'Do not write "deleted_at" into SQL. This is AUDIT L99: the predicate was written out by ' +
  "hand against project_sites, which had no such column, and site progress silently failed on " +
  "every call for months. Use liveOnly() / deletedOnly() / softDeleteAssignment() / " +
  "restoreAssignment() / purgeEligible() from storage/softDelete.ts, which take a table name " +
  "whose type is the explicit list of tables that have the column -- so the wrong table is a " +
  "compile error rather than a runtime one. Reading the column off a row (row.deleted_at) is " +
  "fine and is not what this rule matches.";

const SOFT_DELETE_COLUMN_BAN = [
  // A plain string: ["deleted_at IS NULL", ...], 'SET deleted_at = NOW()'.
  { selector: "Literal[value=/deleted_at/]", message: SOFT_DELETE_COLUMN_BAN_MESSAGE },
  // The literal chunks of a template: `... WHERE deleted_at IS NULL ...`.
  // TemplateElement, not TemplateLiteral: the text lives on the elements, and a
  // selector on the parent would miss it.
  { selector: "TemplateElement[value.raw=/deleted_at/]", message: SOFT_DELETE_COLUMN_BAN_MESSAGE },
];

// Repeated rather than referenced in two places below, because an eslint
// `overrides` block REPLACES a rule's options instead of merging them. The
// comments at each use site say which block is replacing what.
const DYNAMIC_POOL_IMPORT_BAN = {
  // \u002F is a literal "/": the attribute-value regex is itself delimited by
  // /, so a bare slash would close it early.
  selector: "ImportExpression[source.value=/storage\\u002Fpostgres$/]",
  message:
    "Dynamic import of the raw pool is banned for the same reason as the static one: " +
    "getPgPool() bypasses withTenant(), RLS fails closed, and the call site sees zero " +
    "rows rather than an error. Import a store from storage/ instead.",
};

// ── eslint-plugin-react-hooks: scoped to the two React packages ───────────
//
// NOT enabled at the root, and the reason is a measurement rather than a
// preference. Switched on globally, `react-hooks/rules-of-hooks` reported 99
// violations and every single one was in `services/api`: the plugin treats any
// call to a function named `use*` as a React hook, and the storage layer is
// built on `useDatabase()` and `useS3Storage()` -- plain predicates that answer
// "is Postgres configured" and "is S3 configured". There is no React in the API.
//
// So the 99 were noise, and suppressing them one by one would have been 99
// eslint-disable comments protecting nothing. Scoping the plugin to the
// packages that actually render React is the honest configuration: it is the
// code the rule is about, and a real violation there is not drowned.
//
// `exhaustive-deps` is deliberately OFF. It reported 18 across both packages,
// and a dependency array is not a lint fix: adding `load` to an effect's deps
// changes when that effect re-runs, which on these screens is a network
// request. Eighteen of those rewritten in a test branch is eighteen untested
// behaviour changes. They are worth doing as their own piece of work, screen by
// screen, with someone watching the request count. Left on as a warning it
// would also fail the pre-commit hook, which runs lint with --max-warnings=0.
//
// CONSEQUENCE, STATED PLAINLY: this configuration would NOT have caught AUDIT
// L44 -- the portal signing effect that read its in-flight guard while
// declaring only `[tab, photos]`. L44's own note says the plugin "would have
// flagged this", and that is true of the PLUGIN but not of this CONFIG: the
// shape is an exhaustive-deps warning, and exhaustive-deps is the rule turned
// off above. Checked, not reasoned -- L44's original shape linted under this
// config reports nothing, and reports the missing `signingPhotos` dependency
// as soon as exhaustive-deps is switched back on. So rules-of-hooks buys the
// conditional-hook class and buys nothing against the missing-dependency
// class, which is the class L42-L44 actually belong to. See AUDIT L62.
const reactHooks = {
  plugins: ["react-hooks"],
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "off",
  },
};

module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    tsconfigRootDir,
    project: [
      "./tsconfig.json",
      "./services/api/tsconfig.json",
      "./shared/tsconfig.build.json",
      "./apps/mobile/tsconfig.json",
      "./apps/supervisor-web/tsconfig.json",
    ],
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "import"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "error",
  },
  overrides: [
    {
      files: ["babel.config.js", "**/babel.config.js", "metro.config.js", "**/metro.config.js"],
      env: { node: true },
      parserOptions: { sourceType: "script", project: null },
      rules: {
        "no-undef": "off",
        "@typescript-eslint/no-require-imports": "off",
      },
    },
    {
      files: ["apps/mobile/**/*.{ts,tsx}"],
      plugins: reactHooks.plugins,
      rules: {
        "no-restricted-imports": ["error", { patterns: ["services/*", "services/**"] }],
        ...reactHooks.rules,
      },
      parserOptions: { tsconfigRootDir, project: ["./apps/mobile/tsconfig.json"] },
    },
    {
      files: ["apps/supervisor-web/**/*.{ts,tsx}"],
      plugins: reactHooks.plugins,
      rules: {
        "no-restricted-imports": ["error", { patterns: ["services/*", "services/**"] }],
        ...reactHooks.rules,
      },
      parserOptions: { tsconfigRootDir, project: ["./apps/supervisor-web/tsconfig.json"] },
    },
    {
      files: ["services/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "no-restricted-imports": ["error", { patterns: ["apps/*", "apps/**"] }],
      },
      parserOptions: { tsconfigRootDir, project: ["./services/api/tsconfig.json"] },
    },
    // ── H1a: raw connection pool is storage-layer-only ────────────────────
    //
    // Tenant isolation is enforced by Postgres RLS, and the policy reads
    // `current_setting('app.company_id', true)`. That setting is established by
    // storage/tenant.ts -> withTenant(), which opens a transaction and sets it
    // with SET LOCAL semantics. A query issued on the bare pool from
    // getPgPool() never gets that setting.
    //
    // The failure is silent and fails CLOSED, which is why lint has to catch it
    // rather than a test: with no app.company_id, `company_id = NULL` matches
    // nothing, so a forgotten wrapper returns ZERO ROWS on read and a
    // WITH CHECK violation on insert. It never surfaces as another tenant's
    // data and never throws at the call site — it presents as "the data is
    // missing", which reads like a data problem, not a security one.
    //
    // docs/AUDIT.md finding H1a listed this rule; it was the one piece never
    // built. Route and service code must go through a store; stores go through
    // withTenant().
    {
      files: ["services/api/src/**/*.{ts,tsx,js,jsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              // Repeated from the services/** override above: an overrides block
              // REPLACES a rule's options rather than merging them, so omitting
              // this would silently drop the app-import ban for the whole API.
              { group: ["apps/*", "apps/**"], message: "The API must not import application code." },
              {
                group: ["**/storage/postgres"],
                message:
                  "Import a store from storage/ instead of the raw pool. getPgPool() bypasses " +
                  "withTenant(), so the query runs without app.company_id and RLS fails closed — " +
                  "zero rows on read, WITH CHECK violation on insert, no error at the call site. " +
                  "If you genuinely need an untenanted connection (migrations, shutdown, health " +
                  "probes), add the file to the exemption list in .eslintrc.js and say why.",
              },
            ],
          },
        ],
        // no-restricted-imports only visits ImportDeclaration, so it does NOT
        // see `await import("../storage/postgres")` — verified empirically, not
        // assumed. Without this second rule the ban is bypassable by writing the
        // import dynamically, which is exactly what someone reaching for the
        // pool in a route handler would end up doing.
        // Two bans, in one rule because an overrides block replaces a rule's
        // options wholesale: the dynamic pool import, and the soft-delete column
        // name in SQL text (AUDIT L99 -- see the constant's comment above).
        "no-restricted-syntax": ["error", DYNAMIC_POOL_IMPORT_BAN, ...SOFT_DELETE_COLUMN_BAN],
      },
      parserOptions: { tsconfigRootDir, project: ["./services/api/tsconfig.json"] },
    },
    {
      // Exempt, with reasons:
      //   storage/**      the storage layer IS the wrapper; withTenant and every
      //                   store legitimately hold the pool.
      //   server.ts       shutdown drains the pool itself — no tenant context to set.
      //   routes/health.ts readiness probes `SELECT 1` and counts schema_migrations,
      //                   neither of which is tenanted data.
      //   routes/uploads-media-isolation.test.ts
      //                   a tenancy test cannot prove tenancy through the very
      //                   wrapper it is testing. It needs the raw pool for three
      //                   things a store cannot give it: applying migrations,
      //                   creating a NOBYPASSRLS probe role to check that the RLS
      //                   policy itself is enforced by Postgres (the app role is
      //                   BYPASSRLS, so a withTenant query proves nothing about
      //                   the policy), and reading `uploads.company_id` directly
      //                   to confirm which tenant a row was actually attributed
      //                   to. Exempted by exact filename, not by a *.test.ts
      //                   glob, so the ban still holds for every other test.
      //   routes/auth-401-codes-db.test.ts
      //                   same narrow need, and nothing tenanted: it holds the
      //                   pool only to apply migrations before the app boots and
      //                   to drain it afterwards. Every assertion it makes goes
      //                   through the HTTP route, and the one row it creates goes
      //                   through authStore. Also exempted by exact filename.
      files: [
        "services/api/src/storage/**/*.{ts,tsx,js,jsx}",
        "services/api/src/server.ts",
        "services/api/src/routes/health.ts",
        "services/api/src/routes/uploads-media-isolation.test.ts",
        "services/api/src/routes/auth-401-codes-db.test.ts",
      //   routes/invite-accept-identity-db.test.ts
      //                   the same narrow need again: the pool is held only to
      //                   apply migrations before the app boots and to drain it
      //                   afterwards. Every tenanted read and write in that file
      //                   goes through withTenant, which is the point - the row
      //                   it rewrites lives behind FORCE ROW LEVEL SECURITY and
      //                   a bare pool query would silently match nothing.
        "services/api/src/routes/invite-accept-identity-db.test.ts",
      //   routes/crew-permissions-db.test.ts
      //                   narrower still: the pool is held ONLY to apply
      //                   migrations before the app boots and to drain it in
      //                   after(). That file makes no SQL query of its own at
      //                   all - every assertion in it goes through the HTTP
      //                   API, which is the whole point of a permission table,
      //                   so there is no tenanted query for withTenant to wrap.
        "services/api/src/routes/crew-permissions-db.test.ts",
      //   routes/crew-timecards-db.test.ts
      //                   migrations and the drain as above, plus three reads
      //                   the HTTP API deliberately cannot give it. Two of them
      //                   are the same assertion from opposite sides: that a
      //                   refused write did not land, read from the TABLE
      //                   rather than from the route that just refused - a 403
      //                   or 409 returned after the row had already changed
      //                   would satisfy every status assertion in the file. The
      //                   third is migration 033's CHECK constraint, which no
      //                   route can exercise because the route's zod enum
      //                   refuses an undeclared status first; proving the
      //                   constraint EXISTS means writing one past the route,
      //                   inside a transaction that is rolled back.
      //                   Both of those queries set app.company_id with
      //                   set_config in their own transaction, exactly as
      //                   withTenant does, because crew_timecards is RLS-forced
      //                   and a bare pool query would match nothing - which for
      //                   the CHECK probe would be indistinguishable from a
      //                   constraint that is not there. That is why the file
      //                   asserts a VALID write matches one row before trying
      //                   the invalid one. Exact filename.
        "services/api/src/routes/crew-timecards-db.test.ts",
      //   routes/sessions-and-tokens-db.test.ts
      //                   migrations and the drain as above, plus two reads a
      //                   store deliberately cannot give it: that
      //                   `auth_users.token_generation` EXISTS with the right
      //                   type before any assertion depends on it (a missing
      //                   column reads as undefined, and `undefined < 1` is
      //                   false - a revoked token waved through with every test
      //                   green, which is the L11 shape), and the column's value
      //                   after a revocation, to tell "the route answered
      //                   correctly" apart from "the route wrote the number".
      //                   Reading it through loadSessionIdentity would be
      //                   reading the cache the test is trying to get behind.
      //                   `auth_users` is not RLS-forced and carries no
      //                   company_id predicate, so there is no tenant context
      //                   for withTenant to set here. Exact filename again.
        "services/api/src/routes/sessions-and-tokens-db.test.ts",
      //   routes/clients-db.test.ts
      //                   migrations and the drain, and nothing else: the pool
      //                   is held only to apply the migrations before the app
      //                   boots and to end itself in after(). Every read behind
      //                   the route in that file goes through withTenant, which
      //                   is not optional there - `clients` and `project_sites`
      //                   are both FORCE ROW LEVEL SECURITY (032 and 022), so a
      //                   bare pool query would have matched zero rows and the
      //                   ON DELETE SET NULL assertion would have read undefined
      //                   for a site that was sitting there intact. This rule is
      //                   what caught that. Exact filename again.
        "services/api/src/routes/clients-db.test.ts",
      //   routes/job-number-db.test.ts
      //                   migrations and the drain, and nothing else - the same
      //                   two uses as clients-db.test.ts above, for the same
      //                   reason. Every read behind the route in that file goes
      //                   through withTenant: project_sites is FORCE ROW LEVEL
      //                   SECURITY (migration 032), so a bare pool query would
      //                   have matched zero rows and every "the job number did
      //                   not change" assertion would have been satisfied by a
      //                   table the test could not see. Exact filename again.
        "services/api/src/routes/job-number-db.test.ts",
      //   routes/inspection-template-id-db.test.ts
      //                   migrations and the drain as above, plus one read no
      //                   store can give it: whether inspections.template_id
      //                   still HAS its foreign key into inspection_templates,
      //                   read out of information_schema. That constraint is
      //                   the entire premise of the file - without it the guard
      //                   under test refuses ids Postgres would have accepted,
      //                   and three green tests would be defending nothing. It
      //                   is a catalogue query, so there is no tenanted row and
      //                   no company context for withTenant to set; every
      //                   tenanted read and write in the file goes through the
      //                   HTTP API or through inspectionStore.
        "services/api/src/routes/inspection-template-id-db.test.ts",
      //   routes/site-bin-db.test.ts
      //                   migrations and the drain as above, plus two kinds of
      //                   read that are deliberately NOT tenanted: four
      //                   information_schema/catalogue queries (which prove the
      //                   soft-delete column exists with the right type and
      //                   nullability, and that it does NOT exist on the tables
      //                   the registry says are hard-deleted), and two reads of
      //                   `auth_users`, which carries no RLS and no company_id
      //                   predicate -- one of them being what supplies the
      //                   tenant for everything else.
      //
      //                   Every read of a tenanted table in that file goes
      //                   through withTenant, and this rule is why. Four of them
      //                   were written as bare pool queries against
      //                   project_sites and project_entries -- both FORCE ROW
      //                   LEVEL SECURITY -- and would have matched zero rows
      //                   with no error. The partition assertion among them
      //                   would have read `0 + 0 === 0` and PASSED: a vacuous
      //                   assertion in the suite guarding the one destructive
      //                   feature in the phase. There is no Postgres in the
      //                   environment it was written in, so nothing would have
      //                   run it; this rule is what caught it. Exact filename.
        "services/api/src/routes/site-bin-db.test.ts",
      //   routes/signup-consent-db.test.ts
      //                   migrations and the drain as above, plus three reads a
      //                   store cannot give it, all of them about the schema
      //                   rather than about data: that the `document` CHECK
      //                   constraint actually refuses a third value, that
      //                   `auth_pending_registrations` holds no row for a
      //                   refused signup (a 400 response does not say whether a
      //                   row was left behind), and that `user_consents` is NOT
      //                   row-level-security-forced, which is a deliberate
      //                   decision recorded in migration 035 and is a fact only
      //                   pg_class can answer. `user_consents` has no company_id
      //                   at all, so there is no tenant context for withTenant
      //                   to set; every row the file writes through the product
      //                   goes through authStore. Exact filename again.
        "services/api/src/routes/signup-consent-db.test.ts",
      //   routes/signup-company-transaction-db.test.ts
      //                   migrations and the drain as above, plus two reads no
      //                   store can give it. L105's whole subject is what
      //                   COMMITS: a signup refused on the unique phone index
      //                   must leave no company row, and `getCompany` returning
      //                   null does not distinguish "no row" from "a row this
      //                   session cannot see". It also counts rows by
      //                   `owner_email` rather than by the derived id, which is
      //                   a query no store exposes and is deliberately a
      //                   different key from the one the product writes --
      //                   an orphan written under some other id would escape a
      //                   read keyed on `soloCompanyIdForEmail`. `companies`
      //                   is the tenant table itself rather than a tenanted
      //                   one, so there is no company_id for withTenant to set
      //                   while asking whether a company exists; every row the
      //                   file creates goes through authStore and the product's
      //                   own routes. Exact filename again.
        "services/api/src/routes/signup-company-transaction-db.test.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [{ group: ["apps/*", "apps/**"], message: "The API must not import application code." }] },
        ],
        // Must be named explicitly: an overrides block replaces only the rules it
        // lists, so leaving this out would keep the dynamic-import ban switched on
        // for server.ts, whose shutdown path is the one legitimate dynamic import.
        //
        // It used to be a flat "off", and that was wrong in a way nothing
        // reported: the exemption exists for ONE import in server.ts, but the
        // files list covers all of `storage/**` -- every store in the codebase.
        // So a no-restricted-syntax rule added at the API level was silently
        // disabled across the entire storage layer, which is the only place the
        // soft-delete ban has anything to do. The ban would have linted clean
        // and caught nothing. Listing the ban explicitly here is what makes it
        // reach the stores; the dynamic-import ban stays dropped, which is all
        // the "off" was ever meant to do.
        "no-restricted-syntax": ["error", ...SOFT_DELETE_COLUMN_BAN],
      },
      parserOptions: { tsconfigRootDir, project: ["./services/api/tsconfig.json"] },
    },
    {
      files: ["shared/**/*.{ts,tsx,js,jsx}"],
      parserOptions: { tsconfigRootDir, project: ["./shared/tsconfig.build.json"] },
    },
    {
      // The one module allowed to write the soft-delete column name into SQL,
      // and the two tests that assert it does. Last in the list on purpose:
      // overrides are applied in order and the last matching block wins, so
      // this must come after the two blocks above that switch the ban on.
      //
      // Exempting the registry is not a hole in the ban, it is the ban's shape.
      // The column name has to be written down once somewhere; the work is in
      // making that one place the only place, pairing it with the explicit table
      // list, and typing the accessor so a table without the column cannot be
      // passed. A ban with no exemption would just be a module that cannot exist.
      files: [
        "services/api/src/storage/softDelete.ts",
        "services/api/src/storage/softDelete.test.ts",
        "services/api/src/storage/soft-delete-schema-db.test.ts",
      ],
      rules: {
        // Only this rule is named, so the no-restricted-imports exemption these
        // files inherit from the storage/** block above is untouched -- the DB
        // suite legitimately holds the pool to apply migrations.
        "no-restricted-syntax": "off",
      },
    },
    {
      // MERGE-TIME ADDITION, and the one exemption here that is not about the
      // soft-delete registry. workstream 6 adds the column ban; workstream 8
      // adds sqlSchemaAudit.test.ts, whose fixtures carry the L99 predicate ON
      // PURPOSE -- `SELECT id FROM project_sites WHERE company_id = $1 AND
      // deleted_at IS NULL` is the exact defect, fed to the checker to prove
      // the checker reports it, with a positive control on the same statement.
      // Neither branch is wrong and neither sees the other: the ban lints clean
      // on workstream 6 and the fixtures lint clean on workstream 8. Only the
      // union is red -- measured at 3 errors, lines 261/265/270, before this
      // block existed.
      //
      // Exempting it does not weaken the ban. The file writes no SQL that runs:
      // the strings are arguments to extractSqlLiterals, which parses them. And
      // what it tests IS the audit enforcing the same rule as the ban, one
      // layer down. Linting the fixtures would mean the checker for the defect
      // cannot have a test for the defect.
      //
      // ITS OWN BLOCK, NOT AN ENTRY IN THE LIST ABOVE, AND THAT IS THE POINT.
      // Adding this path to the registry block would have set the whole rule to
      // "off" for it, and an overrides block replaces a rule's options wholesale
      // rather than merging them -- so DYNAMIC_POOL_IMPORT_BAN would have gone
      // off for this file too, silently, which is the identical mistake the
      // storage/** block's own comment records having already been made once.
      // The soft-delete ban is what needs dropping here; the pool ban has
      // nothing to do with these fixtures and is re-listed so it stays on.
      files: ["services/api/src/storage/sqlSchemaAudit.test.ts"],
      rules: {
        "no-restricted-syntax": ["error", DYNAMIC_POOL_IMPORT_BAN],
      },
    },
  ],
};
