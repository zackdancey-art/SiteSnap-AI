-- Clients, and the nullable link from a site to one.
--
-- WHAT THIS IS FOR
-- A builder works for the same handful of clients across many sites, and today
-- the only record of that is `project_sites.client`, a free-text string typed
-- again on every site. Two sites for the same client are two unrelated strings:
-- nothing can list a client's sites, nothing can hold a contact for them, and a
-- typo makes a second client.
--
-- WHAT A CLIENT IS NOT
-- It is not an access boundary. Nobody's visibility narrows because of a
-- client_id, and no row in this migration is consulted when deciding who may
-- read or change anything — see the note in storage/recordScope.ts. Clients are
-- filing. The access rules are unchanged by this migration.
--
-- ADDITIVE AND IDEMPOTENT, AND IT WRITES NOTHING TO AN EXISTING ROW
--   - CREATE TABLE IF NOT EXISTS clients
--   - ADD COLUMN IF NOT EXISTS project_sites.client_id, NULLABLE, no default
--   - indexes and RLS policies, all IF NOT EXISTS / DROP-then-CREATE
-- Every existing site keeps its free-text `client` and gets client_id = NULL,
-- which the API renders as "Unfiled". Nothing is backfilled here: turning those
-- strings into rows is a judgement about the owner's data (two spellings of one
-- builder are one client or two, and only they know), so it lives in
-- src/scripts/backfill-clients.ts, which is opt-in, dry-run by default and is
-- not part of the migration sequence. Reversing this migration is dropping one
-- nullable column and one empty table.
--
-- storage/migrate.ts wraps this file in its own BEGIN/COMMIT.

-- ══ 1. The table ══════════════════════════════════════════════════════════════
-- `company_id` is NOT NULL: unlike site_members in 025 there is no parent row to
-- orphan a client from, every insert goes through withTenant with a company, and
-- a NULL here would be a row invisible to its own company with no way to repair
-- it from the product.
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One client per name per company, case- and space-insensitively, so "ABC
-- Builders" and "abc builders " cannot both exist and split a client's sites in
-- two. Enforced in the database rather than only in the route because the route
-- is not the only writer — the backfill script is another.
CREATE UNIQUE INDEX IF NOT EXISTS clients_company_name_unique
  ON clients (company_id, lower(btrim(name)));

-- ══ 2. The link ═══════════════════════════════════════════════════════════════
-- NULLABLE with no default, and that is the whole design: a site filed under no
-- client is the normal state for every row that exists today, and "Unfiled" has
-- to be a first-class group in the UI rather than an error.
--
-- ON DELETE SET NULL, deliberately, NOT CASCADE: deleting a client must never
-- delete sites. It unfiles them. A cascade here would make "remove this client
-- from my list" delete the compliance record of every site ever built for them.
ALTER TABLE project_sites
  ADD COLUMN IF NOT EXISTS client_id TEXT REFERENCES clients(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS project_sites_client_id_idx
  ON project_sites (client_id)
  WHERE client_id IS NOT NULL;

-- ══ 3. RLS, the same pattern as 019-025 ═══════════════════════════════════════
-- ENABLE + FORCE (the app connects as the table owner, so FORCE is what
-- subjects it to the policy) + a company-isolation policy against
-- current_setting('app.company_id', true). Fail-closed: a query that forgets
-- withTenant() has no setting, NULL matches nothing, and it reads zero rows
-- rather than another company's clients.
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clients_company_isolation ON clients;
CREATE POLICY clients_company_isolation ON clients
  USING (company_id = current_setting('app.company_id', true))
  WITH CHECK (company_id = current_setting('app.company_id', true));
