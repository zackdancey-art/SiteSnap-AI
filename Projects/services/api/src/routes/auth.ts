import { Request, Response, Router } from "express";
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
} from "../storage/authStore";
import { acceptSiteInvite, deleteAllUserProjectData } from "../storage/projectsStore";
import { soloCompanyIdForEmail } from "../utils/authToken";
import {
  isChannelConfigured,
  sendAccountVerification,
  sendPasswordReset,
} from "../services/notificationService";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { createAuthToken } from "../utils/authToken";
import { isDisposableEmailDomain } from "../utils/disposableDomains";
import {
  isRateLimitedByIp,
  isRateLimitedByAccount,
  isRateLimitedByPhone,
  isRateLimitedByKey,
  LIMITS,
} from "../middleware/rateLimit";
import { hashPassword, verifyPassword } from "../utils/password";
import { readIntEnv } from "../utils/env";

const SESSION_COOKIE = "sitesnap.session";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
}

const router: Router = Router();
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

function normalizePhone(phone: string) {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return `${hasPlus ? "+" : ""}${digits}`;
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
      new Date(Date.now() + verificationTtlMs)
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
      return res.status(401).json({ error: "Verification code is incorrect." });
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
      return res.status(401).json({ error: "Verification codes are incorrect." });
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

    await createUser(email, passwordHash, pending.phone, fullName, legacyRole, companyId, companyRole);
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
      }),
      user: {
        email: user.email,
        name: user.fullName,
        role: user.role,
        companyId: user.companyId,
        companyRole: user.companyRole,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: "Account already exists for this email or phone." });
    }
    console.error("[auth] register verify failed", error);
    return res.status(500).json({ error: "Unable to verify registration." });
  }
});

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
    if (!existing) {
      return res.status(404).json({ error: "Account not found. Please sign up first." });
    }

    const passwordOk = await verifyPassword(password, existing.passwordHash);
    if (!passwordOk) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    const token = createAuthToken({
      email: existing.email,
      fullName: existing.fullName,
      role: existing.role,
      companyId: existing.companyId,
      companyRole: existing.companyRole,
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
  });
  return res.json({
    token,
    user: {
      email: updated.email, name: updated.fullName, role: updated.role,
      companyId: updated.companyId, companyRole: updated.companyRole,
    },
  });
});

// Permanently delete the authenticated user's account and all their data
router.delete("/auth/account", requireAuth, async (req: Request, res: Response) => {
  if (await isRateLimitedByIp(req, "delete-account", 3, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Too many account deletion attempts." });
  }
  const auth = (req as AuthenticatedRequest).auth;
  try {
    await deleteAllUserProjectData(auth.email);
    await deleteUserAccount(auth.email);
    return res.json({ ok: true, message: "Account and all associated data have been permanently deleted." });
  } catch (error) {
    console.error("[auth] delete-account failed", error);
    return res.status(500).json({ error: "Failed to delete account." });
  }
});

// Refresh a valid (not-expired) token — returns a new token with a fresh expiry
router.post("/auth/refresh", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const user = await findUserByEmail(auth.email);
  const email = user?.email ?? auth.email;
  const fullName = user?.fullName ?? auth.fullName;
  const role = user?.role ?? auth.role;
  const companyId = user?.companyId ?? auth.companyId;
  const companyRole = user?.companyRole ?? auth.companyRole;
  const token = createAuthToken({ email, fullName, role, companyId, companyRole });
  setSessionCookie(res, token);
  return res.json({ token, user: { email, name: fullName, role, companyId, companyRole } });
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
    if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
    const nextHash = await hashPassword(newPassword);
    await updateUserPassword(auth.email, nextHash);
    return res.json({ ok: true });
  } catch (error) {
    console.error("[auth] change-password failed", error);
    return res.status(500).json({ error: "Failed to change password." });
  }
});

// Revoke all other sessions by issuing a rotated token for the current session.
// Without a server-side revocation list, old tokens remain valid until they expire.
router.post("/auth/revoke-all", requireAuth, async (req: Request, res: Response) => {
  const auth = (req as AuthenticatedRequest).auth;
  const user = await findUserByEmail(auth.email);
  const email = user?.email ?? auth.email;
  const fullName = user?.fullName ?? auth.fullName;
  const role = user?.role ?? auth.role;
  const companyId = user?.companyId ?? auth.companyId;
  const companyRole = user?.companyRole ?? auth.companyRole;
  const token = createAuthToken({ email, fullName, role, companyId, companyRole });
  setSessionCookie(res, token);
  return res.json({ token });
});

// Logout — clears the session cookie
router.post("/auth/logout", (_req, res) => {
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
