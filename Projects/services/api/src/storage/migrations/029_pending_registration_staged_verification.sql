-- B0: stage account verification so the SMS is only sent AFTER the email code is
-- verified. Previously POST /auth/register/initiate sent an email AND an SMS in
-- one unauthenticated call, so a single anonymous POST cost one Resend email and
-- one Twilio SMS — and, because the per-account OTP limit keys on email only, an
-- attacker cycling throwaway addresses could flood one real person's phone. The
-- send now requires control of a deliverable mailbox first.
--
-- Schema consequence: sms_code can no longer be written at initiate time, so the
-- NOT NULL from 001 has to go, and the flow needs to record where a pending
-- signup has reached.
--
-- Additive + idempotent: DROP NOT NULL is a no-op if already dropped;
-- ADD COLUMN IF NOT EXISTS. storage/migrate.ts wraps this file in BEGIN/COMMIT.
-- No RLS: auth_pending_registrations is pre-account, so it has no company_id and
-- is never read through withTenant() — it is keyed and read by email alone.

-- ══ 1. sms_code is now written at the second step, not the first ═════════════
ALTER TABLE auth_pending_registrations ALTER COLUMN sms_code DROP NOT NULL;

-- ══ 2. Track how far a pending signup has progressed ═════════════════════════
-- email_verified_at NULL  => email code not yet confirmed; no SMS has been sent.
-- email_verified_at SET   => mailbox proven; sms_code has been generated + sent.
ALTER TABLE auth_pending_registrations
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Last SMS send for this pending signup, so the resend path can enforce a
-- cooldown without a second round trip to the rate-limit store.
ALTER TABLE auth_pending_registrations
  ADD COLUMN IF NOT EXISTS sms_sent_at TIMESTAMPTZ;

-- ══ 3. In-flight signups from the old one-shot flow ══════════════════════════
-- Rows written by the previous code already have BOTH codes sent, so they are
-- effectively past the email stage. Mark them verified rather than stranding the
-- user mid-signup on deploy; they keep working against the new verify endpoint.
-- Bounded by the 10-minute TTL, so this touches at most a few minutes of rows.
UPDATE auth_pending_registrations
   SET email_verified_at = COALESCE(email_verified_at, created_at),
       sms_sent_at       = COALESCE(sms_sent_at, created_at)
 WHERE sms_code IS NOT NULL
   AND email_verified_at IS NULL;
