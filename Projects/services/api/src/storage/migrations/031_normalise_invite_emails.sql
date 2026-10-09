-- 031 — Backfill site_invites.invited_email to its normalised (trimmed,
-- lower-cased) form, so invitations issued before the L46 server fix can
-- actually be accepted.
--
-- WHY THIS IS NEEDED AT ALL
--
-- AUDIT L46. Registration folds case; the invite routes stored what was typed;
-- acceptance compared the two with `!==`. The code fix (normalise on write and
-- compare with sameEmail on read) makes every NEW invitation correct and does
-- nothing for rows already here — and "normalising only new rows leaves every
-- invitation already sent permanently broken" is the whole reason this file
-- exists. An owner cannot re-issue what they cannot see is broken.
--
-- WHAT IT TOUCHES — exactly one column of one table
--
--   site_invites.invited_email
--
-- And nothing else. In particular NOT site_members.member_email and NOT
-- site_invites.invited_by: both are only ever written from an authenticated
-- actor's email, which routes/auth.ts folded before it ever reached a token
-- claim, so they are already normalised and a migration that touches more than
-- it must is a migration nobody can review. Verified by reading every writer of
-- those two columns, not assumed.
--
-- ROW LEVEL SECURITY — the trap this migration would otherwise fall into
--
-- site_invites is FORCE ROW LEVEL SECURITY (migration 025), and FORCE applies
-- to the table owner too. Migrations run as the owner with NO app.company_id
-- set, so current_setting('app.company_id', true) is NULL, the policy matches
-- no rows, and a plain UPDATE here would touch ZERO rows and COMMIT happily —
-- a backfill that enumerates nothing and reports success. FORCE is therefore
-- lifted for the owner-run cross-company write and restored immediately after,
-- which is the 023/024/025 pattern. migrate.ts wraps each file in BEGIN/COMMIT,
-- so a failure anywhere below rolls the lift back with everything else.
--
-- COLLISIONS — why nothing is deleted
--
-- Both unique indexes from migration 018 are on the raw invited_email:
--   site_invites_site_email_partial    (site_id, invited_email)    WHERE site_id IS NOT NULL
--   site_invites_company_email_partial (company_id, invited_email) WHERE company_id IS NOT NULL AND site_id IS NULL
-- so the same person invited twice at different casings is currently TWO rows
-- with two live tokens, and folding both would violate the index. Rather than
-- delete a row, only the most recently issued member of each colliding group is
-- folded; the superseded ones keep their original address. That makes the live
-- invitation — the token actually sitting in somebody's inbox — work, destroys
-- no record, and cannot fail the migration. The superseded rows remain
-- unacceptable, which is what being superseded means, and they expire on their
-- own 7-day schedule.
--
-- IDEMPOTENT: a second run finds nothing to normalise and reports zero.

ALTER TABLE site_invites NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  candidates INTEGER;
  superseded INTEGER;
  normalised INTEGER;
  remaining  INTEGER;
BEGIN
  -- Rank every row that needs folding within its uniqueness group. The two
  -- partial indexes have different keys, so the partition is (site_id) for a
  -- site invite and (company_id) for a company invite; `site_id IS NULL`
  -- separates the two index populations and is kept in the partition to make
  -- that explicit rather than implied by the COALESCE.
  CREATE TEMP TABLE _l46_fold ON COMMIT DROP AS
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY (site_id IS NULL),
                        COALESCE(site_id, company_id, ''),
                        lower(btrim(invited_email))
           ORDER BY expires_at DESC, created_at DESC, id DESC
         ) AS rank
    FROM site_invites
   WHERE invited_email <> lower(btrim(invited_email));

  SELECT COUNT(*) INTO candidates FROM _l46_fold;
  SELECT COUNT(*) INTO superseded FROM _l46_fold WHERE rank > 1;

  UPDATE site_invites si
     SET invited_email = lower(btrim(si.invited_email))
    FROM _l46_fold f
   WHERE f.id = si.id
     AND f.rank = 1;
  GET DIAGNOSTICS normalised = ROW_COUNT;

  RAISE NOTICE '031: % site_invites rows carried a non-normalised invited_email; % normalised, % left as superseded duplicates.',
    candidates, normalised, superseded;

  -- Assert the work actually happened. Every candidate must now be either
  -- normalised or a known superseded duplicate; anything else means the UPDATE
  -- matched fewer rows than it enumerated, which is the failure mode this whole
  -- comment block is about.
  IF normalised <> candidates - superseded THEN
    RAISE EXCEPTION '031: enumerated % foldable rows but normalised % — refusing to commit a partial backfill.',
      candidates - superseded, normalised;
  END IF;

  SELECT COUNT(*) INTO remaining
    FROM site_invites
   WHERE invited_email <> lower(btrim(invited_email));
  IF remaining <> superseded THEN
    RAISE EXCEPTION '031: % rows still non-normalised but only % were superseded duplicates.',
      remaining, superseded;
  END IF;
END $$;

ALTER TABLE site_invites FORCE ROW LEVEL SECURITY;
