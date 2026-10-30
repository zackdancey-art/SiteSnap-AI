-- The client fields a Xero contact maps to, and the nullable link to one.
--
-- WHAT THIS IS FOR
-- Migration 032 promoted `project_sites.client` from free text to a row, with
-- the three things a builder has to hand when adding a client mid-job: a name,
-- a person, and a way to reach them. What it cannot hold is the information an
-- invoice needs — where to send it, and the tax identifier that has to appear
-- on it. That is what this adds.
--
-- ══ WHAT THIS DELIBERATELY DOES NOT ADD: BANK ACCOUNT DETAILS ════════════════
-- No account number, no BSB, no sort code, no IBAN, no payment credential of
-- any kind — not in this migration, not in the store, not in either client's
-- UI. This is written down here, in the schema, so that nobody adds them later
-- believing the integration needs them.
--
-- IT DOES NOT. Xero's API works off a contact record Xero itself holds. The
-- integration's job is to find or create that contact and then reference it by
-- id; the bank details for paying a bill live on Xero's side of that boundary
-- and are read and written there. A copy here would be a second home for a
-- payment credential, with no feature asking for it, inside a compliance
-- product with a seven-year retention policy. The worst outcome of not having
-- them is nothing: no screen is missing, no call fails.
--
-- `xero_contact_id` below is the whole of the integration's footprint in this
-- schema, and it is deliberately the only column here that is NULLABLE.
--
-- ADDITIVE AND IDEMPOTENT, AND IT WRITES NOTHING TO AN EXISTING ROW
--   - five ADD COLUMN IF NOT EXISTS on `clients`
--   - one partial unique index, IF NOT EXISTS
-- No UPDATE, no backfill, no DEFAULT applied to a value anybody typed. Every
-- existing client keeps its name, contact and notes exactly as they are and
-- gets '' for the four text fields and NULL for the link, which is the same
-- state a client created through the form without filling them in reaches.
-- Reversing this migration is dropping five columns nothing reads yet.
--
-- storage/migrate.ts wraps this file in its own BEGIN/COMMIT.

-- ══ 1. The address fields ═════════════════════════════════════════════════════
-- Xero's Contact carries an `Addresses` array whose entries are typed STREET
-- and POBOX — the physical address and the postal one. Two columns, therefore,
-- rather than one: a contractor whose mail goes to a PO box and whose site
-- visits go to a street is the ordinary case, not an edge case.
--
-- FREE TEXT, ONE BLOCK EACH, rather than the four AddressLine / City / Region /
-- PostalCode columns Xero also accepts. The reason is which failure is worse.
-- Xero accepts an address whose whole content is AddressLine1, so a block of
-- text maps cleanly and loses nothing the integration needs. Four columns
-- would be four form fields, on a phone, for a field that is optional — and
-- the predictable result is three of them empty and the whole address typed
-- into the first. Splitting a block later is a migration; un-splitting four
-- half-filled columns is a judgement about somebody's data.
--
-- NOT NULL DEFAULT '' matches contact_name/contact_email/contact_phone in 032,
-- so "not entered" is one representable state across this table rather than
-- two ('' and NULL) that every reader would have to handle.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS physical_address TEXT NOT NULL DEFAULT '';

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS postal_address TEXT NOT NULL DEFAULT '';

-- ══ 2. The tax identifiers ════════════════════════════════════════════════════
-- Two columns, because Xero maps them to two different fields and a builder in
-- New Zealand may have both:
--
--   tax_number      → Xero Contact.TaxNumber     GST number, or an ABN
--   company_number  → Xero Contact.CompanyNumber NZBN
--
-- One combined column would force a choice at entry time that neither the user
-- nor the integration can make later: "9429041234567" is an NZBN and
-- "123-456-789" is a GST number, and nothing in the string says which field it
-- belongs in once they share a column.
--
-- Neither is validated by format here. A GST number's shape differs by country
-- and a refusal on a number the user is reading off a real invoice is worse
-- than storing it: the integration will surface Xero's own rejection, which is
-- the authority on what Xero accepts.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS tax_number TEXT NOT NULL DEFAULT '';

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS company_number TEXT NOT NULL DEFAULT '';

-- ══ 3. The link to Xero's own contact record ══════════════════════════════════
-- NULLABLE with no default, and unlike the four above that is a meaningful
-- distinction rather than a stylistic one. '' in `tax_number` means a user
-- opened the form and left the field blank. NULL here means this client has
-- never been linked to a Xero contact — which is every client today, because
-- nothing writes this column yet.
--
-- Unused on purpose. There is no route that sets it, no UI that shows it, and
-- the store returns it but will not accept it (see routes/clients.ts). It
-- exists now so that the integration, when it is built, is a backfill of one
-- column rather than a migration against a populated clients table.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS xero_contact_id TEXT;

-- One SiteSnap client per Xero contact, per company. Partial, so the NULLs --
-- every row today -- do not collide with each other: in Postgres a unique index
-- treats NULLs as distinct, but the WHERE clause makes that explicit rather
-- than relying on the reader knowing it.
--
-- This is the only constraint in this file, and it guards a real mistake: two
-- SiteSnap clients both linked to the same Xero contact would send one
-- builder's invoices under another's name, and the integration code that
-- creates the link is the kind of code that retries.
CREATE UNIQUE INDEX IF NOT EXISTS clients_company_xero_contact_unique
  ON clients (company_id, xero_contact_id)
  WHERE xero_contact_id IS NOT NULL;

-- ══ 4. RLS: nothing to do, and that is worth stating ══════════════════════════
-- `clients` was made ENABLE + FORCE ROW LEVEL SECURITY with a company-isolation
-- policy in migration 032, and a policy applies to the TABLE, not to a column
-- list. New columns are covered the moment they exist; there is no per-column
-- grant to extend and no policy to re-create here. A reader looking for the
-- RLS section of this migration and finding none has found the right answer.
