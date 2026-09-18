// Anchored to this file's own directory so `parserOptions.project` paths resolve
// against the workspace root (Projects/) no matter what cwd ESLint runs from.
// Without this, `tsconfigRootDir` defaults to cwd, and when `next lint` runs from
// apps/supervisor-web the workspace-relative project paths DOUBLE
// (…/apps/supervisor-web/apps/supervisor-web/tsconfig.json → "Cannot read file").
// This is finding H5. Keep as .js (not .json) so `__dirname` is available.
const tsconfigRootDir = __dirname;

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
      rules: {
        "no-restricted-imports": ["error", { patterns: ["services/*", "services/**"] }],
      },
      parserOptions: { tsconfigRootDir, project: ["./apps/mobile/tsconfig.json"] },
    },
    {
      files: ["apps/supervisor-web/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": ["error", { patterns: ["services/*", "services/**"] }],
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
        "no-restricted-syntax": [
          "error",
          {
            // \u002F is a literal "/": the attribute-value regex is itself
            // delimited by /, so a bare slash would close it early.
            selector: "ImportExpression[source.value=/storage\\u002Fpostgres$/]",
            message:
              "Dynamic import of the raw pool is banned for the same reason as the static one: " +
              "getPgPool() bypasses withTenant(), RLS fails closed, and the call site sees zero " +
              "rows rather than an error. Import a store from storage/ instead.",
          },
        ],
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
      files: [
        "services/api/src/storage/**/*.{ts,tsx,js,jsx}",
        "services/api/src/server.ts",
        "services/api/src/routes/health.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [{ group: ["apps/*", "apps/**"], message: "The API must not import application code." }] },
        ],
        // Must be named explicitly: an overrides block replaces only the rules it
        // lists, so leaving this out would keep the dynamic-import ban switched on
        // for server.ts, whose shutdown path is the one legitimate dynamic import.
        "no-restricted-syntax": "off",
      },
      parserOptions: { tsconfigRootDir, project: ["./services/api/tsconfig.json"] },
    },
    {
      files: ["shared/**/*.{ts,tsx,js,jsx}"],
      parserOptions: { tsconfigRootDir, project: ["./shared/tsconfig.build.json"] },
    },
  ],
};
