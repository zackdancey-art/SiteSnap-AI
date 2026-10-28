import { Request, Response, Router } from "express";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { createHash, randomBytes, randomInt } from "crypto";
import { z } from "zod";
import {
  createCompany,
  createPasswordResetToken,
  createUser,
  deletePasswordResetToken,
  deletePendingRegistration,
  deleteUserAccount,
  findUserByEmail,
  getUserSettings,
  updateUserSettings,
  findUserByIdentifier,
  getPasswordResetToken,
  getPendingRegistration,
  markPendingEmailVerified,
  touchPendingSmsSentAt,
  incrementPendingAttempts,
  purgeExpiredAuthRecords,
  upsertPendingRegistration,
  updateUserProfile,
  updateUserPassword,
  loadSessionIdentity,
  revokeAllSessions,
  recordSignupConsent,
  listConsents,
  type SignupConsent,
} from "../storage/authStore";
import { acceptSiteInvite, deleteAllUserProjectData } from "../storage/projectsStore";
import { soloCompanyIdForEmail } from "../utils/authToken";
import { isTestPhoneNumber, normalizePhone } from "../utils/phoneNumbers";
import {
  isChannelConfigured,
  sendAccountVerification,
  sendPasswordReset,
} from "../services/notificationService";
import {
  requireAuth,
  AuthenticatedRequest,
  AUTH_ERROR_CODES,
  SESSION_EXPIRED_MESSAGE,
  readCredential,
} from "../middleware/auth";
import { createAuthToken, verifyAuthTokenForRefresh } from "../utils/authToken";
import { isDisposableEmailDomain } from "../utils/disposableDomains";
import { parseSignupConsent } from "../utils/signupConsent";
import {
  isRateLimitedByIp,
  isRateLimitedByAccount,
  isRateLimitedByPhone,
  isRateLimitedByKey,
  LIMITS,
} from "../middleware/rateLimit";
import { hashPassword, verifyPassword } from "../utils/password";
import { readIntEnv } from "../utils/env";
import { clearSessionCookie, setSessionCookie } from "../utils/sessionCookie";

const router: Router = asyncSafeRouter();
// An empty ACCOUNT_VERIFICATION_TTL_MS used to parse to 0 here, expiring every
// verification code the moment it was minted — signup broke for everyone and
// the only symptom was a truthful-looking 401. See utils/env.ts.
const verificationTtlMs = readIntEnv("ACCOUNT_VERIFICATION_TTL_MS", 10 * 60 * 1000, { min: 1 });
// Minimum gap between verification SMS sends for one pending signup. Bounds the
// cost of the resend path for someone who has already proven their mailbox.
const smsResendCooldownMs = readIntEnv("SMS_RESEND_COOLDOWN_MS", 60 * 1000, { min: 0 });
const isProd = process.env.NODE_ENV === "production";
const hasDatabase = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeResetToken(): string {
  return randomBytes(32).toString("hex");
}

function makeCode(): string {
  return String(randomInt(100000, 1000000));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function buildResetLink(resetToken: string, channel: "email" | "sms"): string {
  const base =
    channel === "email"
      ? (process.env.PASSWORD_RESET_WEB_URL || "http://localhost:3001/reset-password")
      : (process.env.PASSWORD_RESET_URL || "sitesnap://reset-password");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}token=${encodeURIComponent(resetToken)}`;
}


function isUniqueViolation(err: unknown) {
  return Boolean(
    typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
  );
}

async function initiateRegistration(req: Request, res: Response) {
  if (await isRateLimitedByIp(req, "register-initiate", LIMITS.registerPerIp.max, LIMITS.registerPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many signup attempts from this network. Please try again shortly." });
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "").trim();
  const phoneRaw = String(req.body?.phone ?? "").trim();
  const fullName = String(req.body?.fullName ?? "").trim() || "User";
  const companyName = String(req.body?.companyName ?? "").trim();
  // Company model: the SUPERVISOR_SIGNUP_EMAILS allowlist no longer assigns a
  // role. Every fresh signup becomes the owner of their own company; the legacy
  // `role` column is seeded to 'worker' and coexists during the transition.
  const role = "worker";
  const phone = phoneRaw ? normalizePhone(phoneRaw) : "";

  if (!email || !password || !phone) {
    return res.status(400).json({ error: "Email, phone, and password are required." });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  // Throwaway mailboxes are the cheap half of the SMS-bombing route: the flow
  // costs an attacker one deliverable inbox per phone number they want to hit,
  // and a disposable provider makes that free and automatable. Refused here, as
  // a validation, so no quota and no pending row is spent on it. Bundled static
  // list — deliberately no network lookup in the signup path.
  if (isDisposableEmailDomain(email)) {
    return res.status(400).json({
      error: "Please use a permanent email address. Disposable email providers are not accepted.",
    });
  }
  if (phone.replace(/\D/g, "").length < 8) {
    return res.status(400).json({ error: "Please enter a valid phone number with country code." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  // Terms and privacy consent (L60 / workstream 7). Read here, with the other
  // field validations and BEFORE any OTP quota is spent, so a client that sends
  // a malformed consent is refused without costing the account an email or an
  // SMS allowance.
  //
  // `absent` passes deliberately. See utils/signupConsent.ts for why -- in
  // short, shipped clients do not send these fields yet and the API deploys
  // ahead of them, so requiring consent here would break every signup for the
  // length of that window. The clients are what refuse; this records.
  const consentResult = parseSignupConsent(req.body);
  if (consentResult.kind === "invalid") {
    return res.status(400).json({ error: consentResult.error });
  }
  // The server's clock, not the handset's. The version string is evidence of
  // what the client displayed, which only the client knows; the time is
  // evidence against the client, and a device clock is not evidence at all.
  const signupConsent: SignupConsent | null =
    consentResult.kind === "accepted"
      ? {
          termsVersion: consentResult.termsVersion,
          privacyVersion: consentResult.privacyVersion,
          acceptedAt: new Date(),
        }
      : null;

  // OTP send limits checked after field validation so only real-looking addresses consume quota
  if (await isRateLimitedByAccount(email, "otp-send", LIMITS.otpSendPerAccount.max, LIMITS.otpSendPerAccount.windowMs)) {
    return res.status(429).json({ error: "Too many verification codes requested for this account. Please try again shortly." });
  }
  if (await isRateLimitedByAccount(email, "otp-send-daily", LIMITS.otpSendPerAccountDaily.max, LIMITS.otpSendPerAccountDaily.windowMs)) {
    return res.status(429).json({ error: "Daily verification code limit reached for this account. Please try again tomorrow." });
  }
  if (await isRateLimitedByIp(req, "otp-send", LIMITS.otpSendPerIp.max, LIMITS.otpSendPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many verification requests from this network. Please try again shortly." });
  }

  // PHONE-KEYED CAP, part 1 of 2: peek, do not consume.
  //
  // Stage 1 sends an EMAIL. The SMS — the thing that costs money and lands on a
  // stranger's handset — is dispatched at /auth/register/verify-email, and that
  // is where this counter is incremented. Checking here as well turns an
  // exhausted phone away before a pending row exists, without an abandoned
  // signup that never sent anything eating the victim's own budget.
  //
  // Every other OTP limit above keys on the email, which the attacker picks.
  // Cycling throwaway mailboxes against one real number therefore bought
  // unbounded SMS to a person who never signed up. `phone` is already
  // normalized (normalizePhone runs before validation), so formatting variants
  // share one counter.
  if (
    (await isRateLimitedByPhone(phone, "otp-send", LIMITS.otpSendPerPhone.max, LIMITS.otpSendPerPhone.windowMs, { peek: true })) ||
    (await isRateLimitedByPhone(phone, "otp-send-daily", LIMITS.otpSendPerPhoneDaily.max, LIMITS.otpSendPerPhoneDaily.windowMs, { peek: true }))
  ) {
    return res.status(429).json({ error: "Too many verification codes requested for this phone number. Please try again later." });
  }

  try {
    await purgeExpiredAuthRecords();
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const emailChannel = isChannelConfigured("email");
    const smsChannel = isChannelConfigured("sms");
    if (isProd && !emailChannel.ok) {
      return res.status(500).json({ error: emailChannel.reason });
    }
    if (isProd && !smsChannel.ok) {
      return res.status(500).json({ error: smsChannel.reason });
    }

    const emailCode = makeCode();
    const warnings: string[] = [];

    // Persist BEFORE sending. If the row write fails after a send, the user has
    // a code that verifies nothing; this ordering can only produce the harmless
    // case (a pending row whose email never arrived, expiring in 10 minutes).
    const passwordHash = await hashPassword(password);
    // Pending blob format (:: delimited), backward compatible — companyName is
    // the new 4th field and defaults to '' when absent (mobile signup).
    await upsertPendingRegistration(
      email,
      `${passwordHash}::${fullName}::${role}::${companyName ?? ""}`,
      phone,
      emailCode,
      new Date(Date.now() + verificationTtlMs),
      signupConsent
    );

    // STAGE 1 — email only. No SMS is sent here, and none can be until this
    // code comes back verified at /auth/register/verify-email. That is what
    // stops an anonymous POST from costing a Twilio message, and what stops a
    // stranger's phone being used as a target.
    if (emailChannel.ok) {
      const emailDelivery = await sendAccountVerification({ channel: "email", email, code: emailCode });
      if (!emailDelivery.ok) {
        console.error(`[auth] Email verification delivery failed: ${emailDelivery.error}`);
        if (isProd) {
          return res.status(502).json({ error: emailDelivery.error || "Failed to send email verification code." });
        }
        warnings.push("Email provider unavailable in dev mode.");
      }
    } else {
      warnings.push(emailChannel.reason || "Email provider unavailable in dev mode.");
    }

    const isDevFallback = warnings.length > 0;
    return res.status(200).json({
      ok: true,
      stage: "email",
      message: isDevFallback
        ? "Dev mode: provider not configured, using local verification code."
        : "Verification code sent to your email.",
      warnings: isDevFallback ? warnings : undefined,
      devCodes: !isProd && isDevFallback ? { emailCode } : undefined,
      expiresInSeconds: Math.floor(verificationTtlMs / 1000),
    });
  } catch (error) {
    console.error("[auth] initiateRegistration failed", error);
    return res.status(500).json({ error: "Unable to start registration." });
  }
}

router.post("/auth/register", initiateRegistration);
router.post("/auth/register/initiate", initiateRegistration);

/**
 * STAGE 2 — prove the mailbox, then (and only then) spend an SMS.
 *
 * This is the gate that makes the whole reorder worth doing: reaching it costs
 * an attacker a deliverable mailbox that received a 6-digit code, per phone
 * number they want to target. Calling it again after success re-sends the SAME
 * code under a cooldown rather than minting a new one, so the resend path is
 * not a second cost vector.
 */
router.post("/auth/register/verify-email", async (req, res) => {
  if (await isRateLimitedByIp(req, "register-verify", LIMITS.registerVerifyPerIp.max, LIMITS.registerVerifyPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many verification attempts. Please try again shortly." });
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const emailCode = String(req.body?.emailCode ?? "").trim();

  if (!email || !emailCode) {
    return res.status(400).json({ error: "Email and emailCode are required." });
  }

  try {
    await purgeExpiredAuthRecords();
    const pending = await getPendingRegistration(email);
    if (!pending) {
      return res.status(404).json({ error: "No pending signup found. Please register again.", restart: true });
    }
    if (Date.now() > new Date(pending.expiresAt).getTime()) {
      await deletePendingRegistration(email);
      return res.status(400).json({ error: "Verification code has expired. Please register again.", restart: true });
    }

    if (pending.emailCode !== emailCode) {
      const attempts = await incrementPendingAttempts(email);
      if (attempts >= LIMITS.otpVerifyMaxAttempts) {
        await deletePendingRegistration(email);
        return res.status(429).json({ error: "Too many invalid verification attempts. Please register again.", restart: true });
      }
      return res.status(401).json({
        error: "Verification code is incorrect.",
        code: AUTH_ERROR_CODES.INVALID_VERIFICATION_CODE,
      });
    }

    const smsChannel = isChannelConfigured("sms");
    if (isProd && !smsChannel.ok) {
      return res.status(500).json({ error: smsChannel.reason });
    }

    // PHONE-KEYED CAP, part 2 of 2: consume the budget HERE, where the SMS is
    // actually spent. This is the check that binds; the peek at stage 1 is only
    // an early exit. Counting here is what makes "3 per 15 minutes" mean three
    // messages rather than three attempts — and it is what the tests can verify
    // against getFakeSendsForTests(), since both count the same event.
    //
    // Placed BEFORE markPendingEmailVerified so a rejected caller does not burn
    // the one-shot claim on their own pending row.
    if (await isRateLimitedByPhone(pending.phone, "otp-send", LIMITS.otpSendPerPhone.max, LIMITS.otpSendPerPhone.windowMs)) {
      return res.status(429).json({ error: "Too many verification codes requested for this phone number. Please try again later." });
    }
    if (await isRateLimitedByPhone(pending.phone, "otp-send-daily", LIMITS.otpSendPerPhoneDaily.max, LIMITS.otpSendPerPhoneDaily.windowMs)) {
      return res.status(429).json({ error: "Daily verification code limit reached for this phone number. Please try again tomorrow." });
    }

    // Mint + claim first. The UPDATE is guarded on email_verified_at IS NULL, so
    // two concurrent correct verifications cannot both send: the loser falls
    // through to the resend branch and is cooldown-limited like any other.
    const now = new Date();
    const smsCode = makeCode();
    const claimed = await markPendingEmailVerified(email, smsCode, now);

    let codeToSend = smsCode;
    if (!claimed) {
      // Already verified — this is a resend, not a new stage.
      const current = await getPendingRegistration(email);
      if (!current?.smsCode) {
        return res.status(409).json({ error: "Verification is already in progress. Please register again.", restart: true });
      }
      const lastSent = current.smsSentAt ? new Date(current.smsSentAt).getTime() : 0;
      const sinceLast = Date.now() - lastSent;
      if (lastSent && sinceLast < smsResendCooldownMs) {
        return res.status(429).json({
          error: "A code was just sent. Please wait before requesting another.",
          retryAfterSeconds: Math.ceil((smsResendCooldownMs - sinceLast) / 1000),
        });
      }
      codeToSend = current.smsCode;
      await touchPendingSmsSentAt(email, now);
    }

    const warnings: string[] = [];
    if (smsChannel.ok) {
      const smsDelivery = await sendAccountVerification({ channel: "sms", phone: pending.phone, code: codeToSend });
      if (!smsDelivery.ok) {
        console.error(`[auth] SMS verification delivery failed: ${smsDelivery.error}`);
        if (isProd) {
          // Only undo the cooldown when the caller is TOLD it failed. Otherwise
          // the stamp must stand: dev/test report success (the send is faked),
          // and clearing it there would advertise a cooldown that doesn't hold.
          await touchPendingSmsSentAt(email, null);
          return res.status(502).json({ error: smsDelivery.error || "Failed to send SMS verification code." });
        }
        warnings.push("SMS provider unavailable in dev mode.");
      }
    } else {
      warnings.push(smsChannel.reason || "SMS provider unavailable in dev mode.");
    }

    const isDevFallback = warnings.length > 0;
    return res.status(200).json({
      ok: true,
      stage: "sms",
      message: isDevFallback
        ? "Dev mode: provider not configured, using local verification code."
        : "Verification code sent to your phone.",
      warnings: isDevFallback ? warnings : undefined,
      devCodes: !isProd && isDevFallback ? { smsCode: codeToSend } : undefined,
      expiresInSeconds: Math.max(0, Math.floor((new Date(pending.expiresAt).getTime() - Date.now()) / 1000)),
    });
  } catch (error) {
    console.error("[auth] verify-email failed", error);
    return res.status(500).json({ error: "Unable to verify email code." });
  }
});

router.post("/auth/register/verify", async (req, res) => {
  if (await isRateLimitedByIp(req, "register-verify", LIMITS.registerVerifyPerIp.max, LIMITS.registerVerifyPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many verification attempts. Please try again shortly." });
  }

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const smsCode = String(req.body?.smsCode ?? "").trim();

  if (!email || !smsCode) {
    return res.status(400).json({ error: "Email and smsCode are required." });
  }

  try {
    await purgeExpiredAuthRecords();
    const pending = await getPendingRegistration(email);
    if (!pending) {
      return res.status(404).json({ error: "No pending signup found. Please register again.", restart: true });
    }

    if (Date.now() > new Date(pending.expiresAt).getTime()) {
      await deletePendingRegistration(email);
      return res.status(400).json({ error: "Verification codes have expired. Please register again.", restart: true });
    }

    // The email stage is not optional and not skippable: without it there is no
    // sms_code to match, so this fails closed rather than falling through.
    if (!pending.emailVerifiedAt || !pending.smsCode) {
      return res.status(409).json({
        error: "Verify your email code first.",
        stage: "email",
      });
    }

    if (pending.smsCode !== smsCode) {
      const attempts = await incrementPendingAttempts(email);
      if (attempts >= LIMITS.otpVerifyMaxAttempts) {
        await deletePendingRegistration(email);
        return res.status(429).json({ error: "Too many invalid verification attempts. Please register again.", restart: true });
      }
      return res.status(401).json({
        error: "Verification codes are incorrect.",
        code: AUTH_ERROR_CODES.INVALID_VERIFICATION_CODE,
      });
    }

    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      await deletePendingRegistration(email);
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const [passwordHash, fullName = "User", roleRaw = "worker", companyNameRaw = ""] =
      pending.passwordHash.split("::");
    const legacyRole = roleRaw === "supervisor" || roleRaw === "admin" ? roleRaw : "worker";
    const companyName = companyNameRaw.trim();
    const inviteToken = String(req.body?.inviteToken ?? "").trim();

    // Determine the company + company_role for the new user.
    // Priority: (1) invited join → adopt the invite's company, do NOT create a
    // company; (2) explicit companyName (web) or none (mobile) → new solo company.
    let companyId: string;
    let companyRole: "owner" | "manager" | "viewer" | "crew";

    if (inviteToken) {
      // Create the user first (crew placeholder, no company), then let
      // acceptSiteInvite stamp the invite's company + role transactionally.
      companyId = "";
      companyRole = "crew";
    } else {
      companyId = soloCompanyIdForEmail(email);
      companyRole = "owner";
      const resolvedName = companyName || `${fullName}'s Company`;
      await createCompany({ id: companyId, name: resolvedName, ownerEmail: email });
    }

    // TEST_PHONE_NUMBERS: a listed number is exempt from the uniqueness index
    // and from nothing else. Both verification codes have already been checked
    // above — this is reached only after a real SMS was answered — and the
    // exemption works by storing no phone on the row rather than by relaxing
    // the constraint, so an unlisted number's path through here is unchanged
    // and no migration is involved. See utils/phoneNumbers.ts for why the
    // partial index makes that possible, and for the one consequence: such a
    // row cannot be looked up by phone.
    const phoneToStore = isTestPhoneNumber(pending.phone) ? null : pending.phone;

    // Consent is written BEFORE the user row, and the ordering is the point.
    //
    // user_consents has no foreign key to auth_users (migration 035 says why),
    // so it may be written first -- and writing it first makes the legal record
    // a precondition of the account rather than a step that can be skipped
    // after the account exists. If this throws, the signup 500s with no user
    // created and the person simply retries; the pending row is still here,
    // untouched, because it is deleted below. The other ordering fails the
    // other way: an account that exists with no record of what its owner
    // agreed to, and a 500 that cannot be retried because the email is now
    // taken.
    //
    // The cost of this ordering is a consent row for an account that then
    // failed to create. That row is harmless -- it records something true, that
    // this address accepted these documents at this time -- and the ledger is
    // append-only, so the eventual successful signup adds its own.
    //
    // A pending row with no consent is an older client (see
    // utils/signupConsent.ts). Nothing is written for it, rather than a row
    // claiming an agreement nobody gave.
    const consentRecorded = Boolean(
      pending.consentAcceptedAt && pending.termsVersion && pending.privacyVersion
    );
    if (consentRecorded) {
      await recordSignupConsent(
        email,
        {
          termsVersion: pending.termsVersion as string,
          privacyVersion: pending.privacyVersion as string,
          // The time the person actually ticked the boxes at stage 1, not now.
          // Now is minutes later and two verification codes away, and stamping
          // it would make the record look precise while being wrong.
          acceptedAt: new Date(pending.consentAcceptedAt as string),
        },
        "signup"
      );
    }

    await createUser(email, passwordHash, phoneToStore, fullName, legacyRole, companyId, companyRole);
    await deletePendingRegistration(email);

    // Invited join: consume the invite now that the user row exists.
    if (inviteToken) {
      const accepted = await acceptSiteInvite(email, inviteToken);
      if (accepted === "already_in_company") {
        // Cannot happen for a brand-new user, but guard defensively.
        return res.status(409).json({ error: "This account already belongs to another company." });
      }
      // "not_found" / "expired" / "wrong_user" are non-fatal here: the account
      // is created; the user simply lands with no company yet and can retry the
      // invite. Fall through to token issuance.
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(500).json({ error: "Account created but user lookup failed." });
    }
    return res.status(201).json({
      ok: true,
      token: createAuthToken({
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        companyId: user.companyId,
        companyRole: user.companyRole,
        tokenGeneration: user.tokenGeneration,
      }),
      user: {
        email: user.email,
        name: user.fullName,
        role: user.role,
        companyId: user.companyId,
        companyRole: user.companyRole,
      },
      // Whether a consent record was written for this account. False means the
      // client did not send consent -- an older build -- not that it was
      // refused. Reported rather than silent so that the gap is observable from
      // outside the database while the clients catch up.
      consentRecorded,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: "Account already exists for this email or phone." });
    }
    console.error("[auth] register verify failed", error);
    return res.status(500).json({ error: "Unable to verify registration." });
  }
});

/**
 * A well-formed scrypt hash that no password will match. AUDIT L18, and see
 * loginHandler's own comment for why an unknown email verifies against it.
 *
 * WELL-FORMED is the requirement, not secret: verifyPassword returns false
 * immediately for anything that does not split into `scrypt$salt$hex`, so junk
 * here would skip the derivation and reinstate the timing difference this
 * constant exists to remove. The digest is 64 zero bytes; nothing is going to
 * derive to that, and the salt is public by construction in every stored hash.
 */
const UNMATCHABLE_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;

async function loginHandler(req: Request, res: Response) {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "").trim();
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  // Per-account check first: protects individual accounts from brute-force, regardless of IP.
  // A crew sharing one network gets per-person limits, not a shared pool.
  if (await isRateLimitedByAccount(email, "login", LIMITS.loginPerAccount.max, LIMITS.loginPerAccount.windowMs)) {
    return res.status(429).json({ error: "Too many login attempts for this account. Please try again shortly." });
  }

  // Per-IP backstop: only fires for extremely high volume from a single IP (bots/scanners).
  if (await isRateLimitedByIp(req, "login", LIMITS.loginPerIp.max, LIMITS.loginPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many login attempts from this network. Please try again shortly." });
  }

  try {
    const existing = await findUserByEmail(email);

    /**
     * One answer for both failures. AUDIT L18.
     *
     * An unknown email used to answer 404 "Account not found. Please sign up
     * first." and a wrong password 401 "Incorrect email or password.", which
     * made this route an oracle: anyone could ask it whether a given email has
     * a SiteSnap account and get a reliable yes or no, unauthenticated, at the
     * per-account rate limit. For a product whose users are named site
     * supervisors at identifiable companies, the answer is itself the
     * information worth having -- it is a list of who to phish and with what.
     *
     * The response is now identical in status, code and message either way.
     * So is the WORK: verifying against UNMATCHABLE_HASH makes an unknown
     * email pay for the same scrypt derivation a known one does, because
     * skipping it left the two cases a few milliseconds apart and a timing
     * oracle is the same oracle.
     *
     * The cost is real and deliberate: a genuinely new person who tries to
     * sign in before signing up is no longer told to sign up. That message
     * cannot be restored for them without restoring it for everybody probing
     * the route, since the server cannot tell the two apart -- which is the
     * whole point.
     */
    const passwordOk = await verifyPassword(password, existing?.passwordHash ?? UNMATCHABLE_HASH);
    if (!existing || !passwordOk) {
      return res.status(401).json({
        error: "Incorrect email or password.",
        code: AUTH_ERROR_CODES.INVALID_CREDENTIALS,
      });
    }

    const token = createAuthToken({
      email: existing.email,
      fullName: existing.fullName,
      role: existing.role,
      companyId: existing.companyId,
      companyRole: existing.companyRole,
      tokenGeneration: existing.tokenGeneration,
    });
    setSessionCookie(res, token);
    return res.json({
      ok: true,
      token,
      user: {
        email: existing.email,
        name: existing.fullName,
        role: existing.role,
        companyId: existing.companyId,
        companyRole: existing.companyRole,
      },
    });
  } catch (error) {
    console.error("[auth] login failed", error);
    return res.status(500).json({ error: "Login failed." });
  }
}

router.post("/auth/login", loginHandler);

router.get("/auth/me", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const user = await findUserByEmail(auth.email);
  if (!user && !hasDatabase) {
    return res.json({
      user: {
        email: auth.email, name: auth.fullName, role: auth.role,
        companyId: auth.companyId, companyRole: auth.companyRole,
      },
    });
  }
  if (!user) return res.status(404).json({ error: "User not found." });
  return res.json({
    user: {
      email: user.email, name: user.fullName, role: user.role,
      companyId: user.companyId, companyRole: user.companyRole,
    },
  });
});

// ─── Account settings (personal prefs, migration 028) ───────────────────────────
// Strict at EVERY level: unknown keys are rejected (400), not passed through —
// JSONB has no column constraints, so Zod is the only guard. `.partial()` makes
// fields optional (partial PATCH); `.strict()` closes the object to unknowns. Only
// personal settings live here — timezone and the live-map thresholds are company-
// level and are deliberately NOT accepted (an unknown key here → 400). The strict
// root also rejects any stray `email` in the body, on top of the identity always
// coming from the verified token.
const NotifSettingsSchema = z.object({
  weeklyDigest: z.boolean(),
  approvalAlerts: z.boolean(),
  newEntryAlerts: z.boolean(),
  incidentAlerts: z.boolean(),
  pushEnabled: z.boolean(),
}).partial().strict();
const DisplaySettingsSchema = z.object({
  dateFormat: z.enum(["dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd"]),
  defaultPeriod: z.enum(["daily", "weekly", "monthly"]),
  compactTables: z.boolean(),
}).partial().strict();
const ExportSettingsSchema = z.object({
  defaultFormat: z.enum(["pdf", "word", "html", "csv"]),
  includePhotos: z.boolean(),
  includeSafetyChecklist: z.boolean(),
  includeSignature: z.boolean(),
}).partial().strict();
const AccountSettingsPatchSchema = z.object({
  notifs: NotifSettingsSchema,
  display: DisplaySettingsSchema,
  export: ExportSettingsSchema,
}).partial().strict();

/**
 * What this person agreed to, and when.
 *
 * The read side of the consent record. It exists because a consent record the
 * person it concerns cannot see is evidence for one party only, and because the
 * privacy policy this records agreement to is a document about them.
 *
 * SCOPING. `auth.email` comes from the verified token (middleware/auth.ts), and
 * it is the only input -- there is no path parameter, no query parameter and no
 * body. user_consents has no row level security, deliberately (migration 035),
 * so this line is the entire isolation for the table and is written as narrowly
 * as it can be: no caller can name another address.
 *
 * Called from Projects/apps/mobile/app/settings/data-privacy.tsx, the screen
 * that already links to both documents.
 */
router.get("/auth/consents", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const consents = await listConsents(auth.email);
  return res.json({
    consents: consents.map((consent) => ({
      document: consent.document,
      version: consent.version,
      acceptedAt: consent.acceptedAt,
      source: consent.source,
    })),
  });
});

router.get("/account/settings", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const settings = await getUserSettings(auth.email);
  return res.json({ settings });
});

router.patch("/account/settings", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const parsed = AccountSettingsPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid settings payload.", details: parsed.error.flatten() });
  }
  // Identity is auth.email (verified token) — never req.body/query/params.
  const settings = await updateUserSettings(auth.email, parsed.data as Record<string, Record<string, unknown>>);
  return res.json({ settings });
});

router.patch("/auth/profile", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const fullName = String(req.body?.name ?? "").trim();
  const roleRaw = String(req.body?.role ?? "").trim().toLowerCase();
  const requestedRole =
    roleRaw === "worker" || roleRaw === "supervisor" || roleRaw === "admin"
      ? roleRaw
      : undefined;
  if (requestedRole && auth.role !== "admin") {
    return res.status(403).json({ error: "Only admins can change roles." });
  }
  const updated = await updateUserProfile(auth.email, {
    fullName: fullName || undefined,
    role: requestedRole,
  });
  if (!updated && !hasDatabase) {
    const nextName = fullName || auth.fullName;
    const nextRole = requestedRole || auth.role;
    const token = createAuthToken({
      email: auth.email, fullName: nextName, role: nextRole,
      companyId: auth.companyId, companyRole: auth.companyRole,
      // No record to read, so carry forward the generation the caller presented.
      tokenGeneration: auth.tokenGeneration,
    });
    return res.json({
      token,
      user: {
        email: auth.email, name: nextName, role: nextRole,
        companyId: auth.companyId, companyRole: auth.companyRole,
      },
    });
  }
  if (!updated) return res.status(404).json({ error: "User not found." });
  const token = createAuthToken({
    email: updated.email, fullName: updated.fullName, role: updated.role,
    companyId: updated.companyId, companyRole: updated.companyRole,
    tokenGeneration: updated.tokenGeneration,
  });
  return res.json({
    token,
    user: {
      email: updated.email, name: updated.fullName, role: updated.role,
      companyId: updated.companyId, companyRole: updated.companyRole,
    },
  });
});

// Delete the authenticated user's account and the records in it.
//
// Deliberately NOT described as deleting "all their data", because it does not:
//   - no code path in this service deletes a stored photograph. The media
//     storage adapter (storage/mediaStorage.ts) exposes exactly saveFile and
//     readFile, and the only S3 commands imported anywhere are GetObject and
//     PutObject. Deleting the row removes the pointer; the object stays.
//   - rows the user authored under a *former* company keep that company_id and
//     are left untouched by design (see deleteAllUserProjectData).
// The response message says what actually happened. Changing it to promise more
// than the code does is how the old wording came about.
router.delete("/auth/account", requireAuth, async (req: Request, res: Response) => {
  if (await isRateLimitedByIp(req, "delete-account", 3, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many account deletion attempts." });
  }
  const auth = (req as AuthenticatedRequest).auth;
  try {
    await deleteAllUserProjectData(auth.email);
    await deleteUserAccount(auth.email);
    return res.json({
      ok: true,
      message:
        "Your account and the records in it have been deleted. Photographs you " +
        "already uploaded stay in our file storage — see the Privacy Policy.",
    });
  } catch (error) {
    console.error("[auth] delete-account failed", error);
    return res.status(500).json({ error: "Failed to delete account." });
  }
});

/**
 * POST /auth/refresh — exchange a token for a fresh one.
 *
 * AUDIT L74: THIS ROUTE DOES NOT SIT BEHIND `requireAuth`, AND THAT IS THE FIX.
 *
 * It used to. `requireAuth` refuses an expired token — that is its job — so the
 * endpoint whose entire purpose is to replace a token that is running out
 * refused exactly the tokens that needed replacing. The only tokens it would
 * renew were ones that did not yet need renewing, and a client that was offline
 * or asleep across the expiry boundary had no way back in but a sign-in. On a
 * seven-day TTL that is a crew signing in every week for no reason.
 *
 * So it reads the credential itself and verifies with `verifyAuthTokenForRefresh`,
 * which accepts a token whose `exp` has passed but is still inside the idle
 * window (`utils/authToken.ts`: the window is the cookie's max age, so the
 * grace is the difference between the two and is derived rather than invented).
 *
 * WHAT IT STILL REFUSES, and must:
 *   - no credential at all;
 *   - a tampered or forged signature, or a malformed token;
 *   - a token past the idle window as well as its expiry — expiry with grace is
 *     not expiry abolished;
 *   - a token for an account that no longer exists;
 *   - A REVOKED TOKEN. A generation behind the row is refused here exactly as
 *     it is everywhere else. If refresh were exempt, revocation would be
 *     theatre: the one credential a password change or a revoke-all is meant to
 *     kill would be the one that could mint its own replacement forever.
 *
 * All of those answer 401 `session_expired`, in the same words, deliberately —
 * see the note in AUTH_ERROR_CODES on what a more specific answer tells someone
 * probing. A store that is merely unreachable answers 503, never 401: see the
 * same note, and L73.
 */
router.post("/auth/refresh", async (req: Request, res: Response) => {
  // THE ORDER OF THESE THREE CHECKS MATTERS.
  //
  // Per-IP first, because it needs no identity and is the only thing standing
  // between an unauthenticated flood and the HMAC work below.
  if (await isRateLimitedByIp(req, "refresh", LIMITS.refreshPerIp.max, LIMITS.refreshPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many refresh attempts. Please try again shortly." });
  }

  const credential = readCredential(req);
  if (!credential) {
    return res.status(401).json({ error: "Missing bearer token.", code: AUTH_ERROR_CODES.NO_CREDENTIAL });
  }
  const claims = verifyAuthTokenForRefresh(credential.token);
  if (!claims) {
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }

  // Per-account AFTER verification, so the budget can only be spent by someone
  // already holding a signed token for that account. Checking it on the claimed
  // email before verifying would hand anyone a way to exhaust a victim's
  // refresh allowance with garbage and strand them at the login screen — a
  // denial of service built out of a rate limiter.
  if (await isRateLimitedByAccount(claims.email, "refresh", LIMITS.refreshPerAccount.max, LIMITS.refreshPerAccount.windowMs)) {
    return res.status(429).json({ error: "Too many refresh attempts. Please try again shortly." });
  }

  const result = await loadSessionIdentity(claims.email);
  if (!result.ok) {
    if (result.reason === "unavailable") {
      console.error("[auth] refresh could not read the session identity", result.error);
      return res.status(503).json({
        error: "We could not verify your session just now. Please try again in a moment.",
        code: AUTH_ERROR_CODES.SESSION_UNAVAILABLE,
      });
    }
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }
  const identity = result.identity;

  // `<`, not `!==`: see the matching note in middleware/auth.ts. A token AHEAD
  // of the row is this instance's cache lagging a revocation served elsewhere,
  // not a forgery — the signature already proved that — and refusing it would
  // sign someone out for the cache's mistake.
  if (claims.tokenGeneration < identity.tokenGeneration) {
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }

  // Minted from the ROW, which is the whole model (THE SESSION MODEL,
  // storage/authStore.ts). A refresh that copied the old claims forward would
  // hand back a token as stale as the one it replaced.
  const tokenGeneration = Math.max(claims.tokenGeneration, identity.tokenGeneration);
  const token = createAuthToken({
    email: identity.email,
    fullName: identity.fullName,
    role: identity.role,
    companyId: identity.companyId,
    companyRole: identity.companyRole,
    tokenGeneration,
  });
  // The cookie is set for both transports, as it was before this change: the
  // portal needs it and a bearer client simply never reads it.
  setSessionCookie(res, token);
  return res.json({
    token,
    user: {
      email: identity.email,
      name: identity.fullName,
      role: identity.role,
      companyId: identity.companyId,
      companyRole: identity.companyRole,
    },
  });
});

// Change password — requires current password verification
router.post("/auth/change-password", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  if (await isRateLimitedByAccount(auth.email, "change-password", 5, 15 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many password change attempts. Please try again shortly." });
  }
  const currentPassword = String(req.body?.currentPassword ?? "").trim();
  const newPassword = String(req.body?.newPassword ?? "").trim();
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "currentPassword and newPassword are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  try {
    const user = await findUserByEmail(auth.email);
    if (!user) return res.status(404).json({ error: "Account not found." });
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    // INVALID_CREDENTIALS, not SESSION_EXPIRED. This is the one authenticated
    // request whose 401 would otherwise sign a person out of the app for
    // mistyping their own current password.
    if (!ok) {
      return res.status(401).json({
        error: "Current password is incorrect.",
        code: AUTH_ERROR_CODES.INVALID_CREDENTIALS,
      });
    }
    const nextHash = await hashPassword(newPassword);
    // THE REPLACEMENT TOKEN IS NOT A COURTESY.
    //
    // `updateUserPassword` increments the token generation, which is the point
    // of changing a password: every other session on the account stops working.
    // But "every other session" includes the one making this request. Returning
    // `{ ok: true }` and nothing else — which is what this route used to do —
    // signs the person out of the device they just changed their password on,
    // one request later, with no explanation. The replacement is minted at the
    // generation the write returned, so it is the only token on the account
    // that still works.
    //
    // The portal needs the Set-Cookie (its cookie is httpOnly and it cannot
    // read the body's token); the mobile client reads `token` out of the body
    // and stores it (apps/mobile/app/settings/account.tsx). Both halves are
    // required, and a client that ignored the token WOULD be signed out — which
    // is why the mobile change ships with this one.
    const nextGeneration = await updateUserPassword(auth.email, nextHash);
    if (nextGeneration === null) {
      // The row vanished between the lookup above and the write. Nothing was
      // changed, so do not hand back a credential for it.
      return res.status(404).json({ error: "Account not found." });
    }
    const token = createAuthToken({
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      companyId: user.companyId,
      companyRole: user.companyRole,
      tokenGeneration: nextGeneration,
    });
    // UNCONDITIONAL, AND NOT AN OVERSIGHT. DO NOT GATE THIS ON TRANSPORT.
    //
    // `/projects/invites/accept` writes its Set-Cookie only when
    // `authTransport === "cookie"`, and the two look inconsistent side by side.
    // A consistency pass that gates this one to match would sign out every
    // portal user who changes their password: the cookie they arrived with is
    // one generation behind the moment `updateUserPassword` returns, and
    // `requireAuth` refuses a token behind the record (middleware/auth.ts:193)
    // BEFORE it reaches the staleClaims repair (middleware/auth.ts:247) — so
    // nothing downstream can rescue it. The Set-Cookie is the only thing there.
    //
    // The reason accept can gate it and this cannot: accept hands a bearer
    // caller a token at a DIFFERENT generation from the cookie it would also
    // set, and a device holding two credentials at two generations is a bug
    // waiting to be found. Here the cookie and `token` in the body are the SAME
    // token, minted once above, so setting both costs nothing and risks nothing.
    //
    // Guarded by "a password change replaces the portal's cookie, and the cookie
    // that made the change stops working" in sessions-and-tokens.test.ts.
    // Verified red-on-revert: deleting this line fails that test and NOTHING
    // else — all seven change-password.test.ts cases and the bearer-transport
    // twin stay green, which is why the test had to be written before this
    // comment could claim anything.
    setSessionCookie(res, token);
    return res.json({ ok: true, token });
  } catch (error) {
    console.error("[auth] change-password failed", error);
    return res.status(500).json({ error: "Failed to change password." });
  }
});

/**
 * POST /auth/revoke-all — end every session on the account but this one.
 *
 * AUDIT L75: IT USED TO INVALIDATE NOTHING.
 *
 * The old implementation read the user row, minted a token from it, set the
 * cookie and returned. Every word of that is a rotation of the CURRENT
 * session's credential; not one of it touched any other session. The comment
 * above it said so, almost — "without a server-side revocation list, old tokens
 * remain valid until they expire" — and then the route was shipped and offered
 * to people under a name that promises the opposite. A phone left in a taxi
 * kept full access for up to seven days, and the person who pressed the button
 * had been told it was handled.
 *
 * `revokeAllSessions` is the revocation list, in one integer on the row: it
 * increments the generation, every token minted before it is now behind the
 * row, and `requireAuth` and `/auth/refresh` both refuse a token that is
 * behind. The replacement minted here is at the new generation, so the device
 * that asked stays signed in and every other one is out at its next request.
 */
router.post("/auth/revoke-all", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const user = await findUserByEmail(auth.email);
  if (!user) {
    // requireAuth read a row for this email moments ago, so this is an account
    // deleted mid-request. Minting a token for it would be minting a credential
    // for an account that no longer exists.
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }
  const nextGeneration = await revokeAllSessions(user.email);
  if (nextGeneration === null) {
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }
  const token = createAuthToken({
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    companyId: user.companyId,
    companyRole: user.companyRole,
    tokenGeneration: nextGeneration,
  });
  setSessionCookie(res, token);
  return res.json({ token });
});

/**
 * POST /auth/logout — end the session, not just the cookie.
 *
 * HALF-BUILT-MECHANISMS F5: this route used to be four lines that cleared the
 * cookie and returned. A bearer client (the mobile app) therefore signed out by
 * deleting its own copy of a credential that stayed valid on the server for the
 * rest of its TTL — up to seven days — and a cookie client signed out by
 * discarding a cookie that any other copy of could still present. "Sign out"
 * is the control a person uses when they no longer trust the device in their
 * hand, and it did not revoke anything.
 *
 * `token_generation` was built in Phase 2 for exactly this and used only by
 * revoke-all and change-password. Logout now increments it too.
 *
 * THE CONSEQUENCE, STATED: the generation is per ACCOUNT, not per session, so
 * signing out on one device signs out every device on that account. That is a
 * deliberate trade and it is the reversible one — a per-session denylist needs
 * a table, a write on every request, and a decision about where it lives, and
 * none of that can be undone cheaply. Reverting this is deleting the
 * `revokeAllSessions` call below.
 *
 * It never fails. No `requireAuth`: a logout called with an already-dead token
 * would 401 and leave the cookie in place, which is the opposite of what the
 * caller asked for. Instead the credential is read if present, the generation
 * is bumped if it verifies, and the cookie is cleared either way. Always 200.
 *
 * `verifyAuthTokenForRefresh`, not `verifyAuthToken`, and the difference is
 * load-bearing. The refresh variant accepts a token inside the idle grace
 * window, and that is exactly the set of tokens that are not currently usable
 * but CAN be exchanged for a live one at `/auth/refresh`. Verifying strictly
 * would mean a person whose access token expired an hour ago presses Sign Out,
 * nothing is revoked, and the session is resurrected by the next refresh.
 */
router.post("/auth/logout", async (req, res) => {
  const credential = readCredential(req);
  const claims = credential ? verifyAuthTokenForRefresh(credential.token) : null;
  if (claims) {
    // Returns null for an account that no longer exists, which needs no
    // revoking. Invalidates the cached identity itself, so the next request
    // on any instance reads the new generation rather than a 60-second ghost.
    await revokeAllSessions(claims.email);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

router.post("/auth/forgot-password", async (req, res) => {
  if (await isRateLimitedByIp(req, "forgot-password", LIMITS.forgotPasswordPerIp.max, LIMITS.forgotPasswordPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many reset requests. Please try again shortly." });
  }

  const identifier = String(req.body?.identifier ?? "").trim();
  const channel = String(req.body?.channel ?? "email").toLowerCase() === "sms" ? "sms" : "email";

  if (!identifier) {
    return res.status(400).json({ error: "Email or phone is required." });
  }

  if (channel === "email" && !isValidEmail(identifier)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  /**
   * IDENTIFIER-KEYED CAP.
   *
   * Until now only forgotPasswordPerIp applied, and this endpoint accepts
   * channel=sms: an attacker who knew one victim's email could text that
   * victim's phone from as many rented IPs as they liked. The budget has to
   * belong to the address being targeted, not to the network doing the
   * targeting.
   *
   * One canonical key per identifier, so "+61 400 000 000" and
   * "+61400000000" — and Bob@x.com and bob@x.com — cannot each hold their own.
   *
   * Checked BEFORE findUserByIdentifier on purpose, and for two reasons:
   *  - the limit then applies uniformly whether or not the account exists, so
   *    it cannot be used as an oracle; and
   *  - a known and an unknown identifier are refused after the same amount of
   *    work, so the 429 does not leak account existence through response time.
   * It sits after field validation so malformed input cannot consume a real
   * address's quota.
   */
  const limitKey = isValidEmail(identifier) ? identifier.toLowerCase() : normalizePhone(identifier);
  if (
    (await isRateLimitedByKey("identifier", limitKey, "forgot-password", LIMITS.forgotPasswordPerIdentifier.max, LIMITS.forgotPasswordPerIdentifier.windowMs)) ||
    (await isRateLimitedByKey("identifier", limitKey, "forgot-password-daily", LIMITS.forgotPasswordPerIdentifierDaily.max, LIMITS.forgotPasswordPerIdentifierDaily.windowMs))
  ) {
    return res.status(429).json({ error: "Too many reset requests for this account. Please try again later." });
  }

  try {
    await purgeExpiredAuthRecords();
    const channelConfig = isChannelConfigured(channel);
    if (isProd && !channelConfig.ok) {
      return res.status(500).json({ error: channelConfig.reason });
    }

    const normalizedIdentifier = identifier.toLowerCase();
    const normalizedPhone = normalizePhone(identifier);
    const user = await findUserByIdentifier(normalizedIdentifier, normalizedPhone);

    if (user) {
      const resetToken = makeResetToken();
      const resetLink = buildResetLink(resetToken, channel);
      const tokenHash = hashToken(resetToken);
      await createPasswordResetToken(tokenHash, user.email, new Date(Date.now() + 1000 * 60 * 30));

      if (channelConfig.ok) {
        const delivery = await sendPasswordReset({
          channel,
          email: user.email,
          phone: user.phone ?? undefined,
          resetLink,
        });

        if (!delivery.ok) {
          console.error(`[auth] Password reset delivery failed: ${delivery.error}`);
          if (isProd) {
            return res.status(502).json({ error: delivery.error || "Failed to send reset instructions." });
          }
          return res.json({
            ok: true,
            message: "Dev mode: provider not configured, using local reset token.",
            devResetToken: !isProd ? resetToken : undefined,
            devResetLink: !isProd ? resetLink : undefined,
          });
        }
      } else {
        return res.json({
          ok: true,
          message: "Dev mode: provider not configured, using local reset token.",
          devResetToken: !isProd ? resetToken : undefined,
          devResetLink: !isProd ? resetLink : undefined,
        });
      }
    }

    return res.json({
      ok: true,
      message:
        channel === "sms"
          ? "If an account exists, a reset code has been sent by text message."
          : "If an account exists, a reset link has been sent by email.",
    });
  } catch (error) {
    console.error("[auth] forgot-password failed", error);
    return res.status(500).json({ error: "Unable to process reset request." });
  }
});

router.post("/auth/reset-password", async (req, res) => {
  if (await isRateLimitedByIp(req, "reset-password", LIMITS.resetPasswordPerIp.max, LIMITS.resetPasswordPerIp.windowMs)) {
    return res.status(429).json({ error: "Too many reset attempts. Please try again shortly." });
  }

  const token = String(req.body?.token ?? "").trim();
  const newPassword = String(req.body?.newPassword ?? "").trim();

  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token and newPassword are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  try {
    await purgeExpiredAuthRecords();
    const tokenHash = hashToken(token);
    const resetRecord = await getPasswordResetToken(tokenHash);
    if (!resetRecord) {
      return res.status(400).json({ error: "This reset link is invalid or has already been used. Please request a new one." });
    }

    if (Date.now() > new Date(resetRecord.expiresAt).getTime()) {
      await deletePasswordResetToken(tokenHash);
      return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
    }

    const user = await findUserByEmail(resetRecord.email);
    if (!user) {
      await deletePasswordResetToken(tokenHash);
      return res.status(404).json({ error: "Account not found." });
    }

    const nextHash = await hashPassword(newPassword);
    await updateUserPassword(resetRecord.email, nextHash);
    await deletePasswordResetToken(tokenHash);
    return res.json({ ok: true, message: "Password has been reset. You can now sign in with your new password." });
  } catch (error) {
    console.error("[auth] reset-password failed", error);
    return res.status(500).json({ error: "Unable to reset password." });
  }
});

export default router;
