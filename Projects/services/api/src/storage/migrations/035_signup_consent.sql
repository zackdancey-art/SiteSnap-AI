-- L60 / workstream 7: record terms and privacy consent at signup, with a
-- timestamp and the version of the document the person was actually shown.
--
-- Nothing in this codebase recorded consent before this migration. There was no
-- column, no table and no route: a grep for consent, terms_accepted,
-- privacy_accepted, acceptedTerms and termsVersion across services/api/src
-- returned nothing at all. So for an App Store submission the product could not
-- answer "when did this user agree, and to what" for any user.
--
-- TWO PARTS, because signup is three stages and consent is given at the first.
--
-- The person ticks the box at POST /auth/register, which only writes a pending
-- row; the account is not created until POST /auth/register/verify, after an
-- email code and an SMS code. So the moment of consent is recorded on the
-- pending row (part 1) and moved onto the permanent ledger when the account
-- comes into existence (part 2). Recording it only at the end would stamp the
-- verification time -- minutes later, and after two code entries -- as the
-- moment of agreement, which is a worse record than no record, because it looks
-- precise and is wrong.
--
-- Additive and idempotent throughout: ADD COLUMN IF NOT EXISTS and
-- CREATE TABLE/INDEX IF NOT EXISTS. storage/migrate.ts wraps this file in
-- BEGIN/COMMIT. Nothing here backfills, rewrites or deletes a row.

-- ══ 1. The pending signup carries the consent until the account exists ══════
-- auth_pending_registrations has NO RLS and no company_id -- it is pre-account
-- and keyed by email alone, as migration 029 records. These columns inherit
-- that: they are read and written on the bare pool, never through withTenant().
--
-- All three are NULLABLE, and that is the deploy story rather than laziness. A
-- shipped mobile build and a shipped portal build both POST /auth/register
-- today without these fields. The API deploys from main on merge while the
-- client builds ship separately, so for the length of that window every signup
-- would 400 if consent were required. NULL means "this signup predates the
-- consent control"; it is distinguishable from a refusal, which cannot reach
-- here because the clients disable the button.
ALTER TABLE auth_pending_registrations
  ADD COLUMN IF NOT EXISTS terms_version TEXT;

ALTER TABLE auth_pending_registrations
  ADD COLUMN IF NOT EXISTS privacy_version TEXT;

-- Server clock, set when the POST carrying the consent arrives. Deliberately
-- not a client-supplied timestamp: the version string is evidence of what the
-- client displayed and only the client knows it, but the time is evidence
-- against the client and a handset clock is not evidence of anything.
ALTER TABLE auth_pending_registrations
  ADD COLUMN IF NOT EXISTS consent_accepted_at TIMESTAMPTZ;

-- ══ 2. The permanent, append-only consent ledger ════════════════════════════
--
-- WHY A LEDGER AND NOT FOUR COLUMNS ON auth_users
-- Consent is given to a version, and the documents are revised -- the canonical
-- files in docs/legal/ carry a "Last updated" line that CI pins across all
-- three copies of each document (Projects/scripts/ci.sh, assert_legal_copies).
-- Columns on the user row would record only the most recent acceptance and
-- overwrite the earlier one, so the question a consent record exists to answer
-- -- what did this person agree to at the time -- would be unanswerable the
-- first time the terms change.
--
-- WHY NO company_id AND NO ROW LEVEL SECURITY
-- This is the deliberate decision in this migration and the one most worth
-- disagreeing with, so it is written out.
--
-- Consent is a fact about a person, not about a company. A crew member invited
-- by one employer and later by another gives consent once; the agreement is
-- between that person and SiteSnap. auth_users and auth_pending_registrations
-- are the two tables in this schema with no RLS for the same reason -- they are
-- identity rather than tenant data (migration 014 for companies, 029 for
-- pending) -- and this belongs with them.
--
-- There is also a concrete trap avoided. At the point the consent row is
-- written, an INVITED signup has company_id = "": routes/auth.ts creates the
-- user with an empty company and acceptSiteInvite() stamps the real one
-- afterwards. A company_id column here would therefore be written as "" for
-- every invited user, and under FORCE ROW LEVEL SECURITY those rows would then
-- be invisible to the company that actually employs them -- silently, matching
-- zero rows with no error, which is exactly the failure mode migration 025
-- documents. Not having the column cannot get that wrong.
--
-- The cost: a query here is not tenant-isolated by the database, so every route
-- reading this table must scope by the authenticated caller's own email. There
-- is exactly one such route (GET /api/auth/consents) and it reads
-- req.user.email, never a parameter.
--
-- WHY NO FOREIGN KEY TO auth_users
-- Consistent with the schema-wide choice recorded in CLAUDE.md: there are no
-- foreign keys back to companies either, deliberately, for soft-cancel and
-- seven-year retention. A cascade from auth_users would mean deleting an
-- account destroys the evidence that the account holder ever agreed to
-- anything, which is the one record most likely to be needed after a dispute
-- about a deleted account. The consequence is stated plainly: deleteUserAccount
-- leaves these rows behind. Whether that is the right answer under the privacy
-- policy's own deletion promise is a legal question, not an engineering one,
-- and it is flagged for the owner rather than settled here. Adding a cascade
-- later is one line; recovering destroyed evidence is not.
CREATE TABLE IF NOT EXISTS user_consents (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  -- 'terms' or 'privacy'. A TEXT column with a CHECK rather than an enum type,
  -- matching how every other small vocabulary in this schema is stored, so
  -- adding a third document is a migration and not a type alteration.
  document TEXT NOT NULL,
  -- Verbatim, as the client reported it: the "Last updated: 3 October 2026"
  -- line of the document that was rendered to this person. Not normalised to a
  -- number, because the line is the thing CI pins across every copy of the
  -- text, so it is the one identifier that cannot drift from the words it
  -- names.
  version TEXT NOT NULL,
  -- When the person agreed, server clock, carried from the pending row.
  accepted_at TIMESTAMPTZ NOT NULL,
  -- When this row was written. Differs from accepted_at by the length of the
  -- email + SMS verification, and keeping both is what makes the gap auditable
  -- rather than invisible.
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- How it was given: 'signup' today. A re-acceptance after a document
  -- revision would be another value, which is why this is a column now rather
  -- than an assumption later.
  source TEXT NOT NULL,
  CONSTRAINT user_consents_document_check CHECK (document IN ('terms', 'privacy'))
);

-- Deliberately NOT unique on (user_email, document, version). This is an
-- append-only ledger: the same person may legitimately accept the same version
-- twice -- re-signing up after deleting an account, most obviously, since the
-- rows above survive the deletion. A unique index would turn that into a 23505
-- on the last step of signup, and the second acceptance is a fact, not a
-- duplicate.
CREATE INDEX IF NOT EXISTS idx_user_consents_email_document
  ON user_consents (user_email, document, accepted_at DESC);
