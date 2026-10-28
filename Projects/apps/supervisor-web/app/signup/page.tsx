"use client";

/**
 * The portal's signup route — the other half of hop 5.
 *
 * Deliberately INVITE-ONLY. It requires ?inviteToken= and refuses to proceed
 * without one. The portal has never had a signup route and self-serve company
 * creation on the manager portal is a product decision nobody has taken; what
 * was missing, and all that is being added here, is a way for an invited person
 * to turn an invitation into an account. Reached without a token, this page
 * says so and points at sign-in rather than quietly creating a company.
 *
 * Three steps, because that is what the API does and the reason matters: the
 * mailbox is proved BEFORE an SMS is spent (see the comment on
 * /auth/register/verify-email), so the order cannot be collapsed.
 *
 *   1. details   -> POST /auth/register
 *   2. emailCode -> POST /auth/register/verify-email
 *   3. smsCode   -> POST /auth/register/verify  (consumes the invitation)
 *   4. login     -> because step 3 sets NO session cookie
 *
 * Step 4 is not optional and not tidying. /auth/register/verify returns a token
 * in its body and never calls setSessionCookie; the portal authenticates by
 * httpOnly cookie, so without the login call the account would exist and the
 * person would still be logged out.
 *
 * Step 1 also carries terms and privacy consent, which is recorded against the
 * pending registration and written into the consent ledger when the account is
 * created. The portal links to the hosted documents rather than holding copies
 * of them; lib/legal-versions.ts says why, and names what keeps the version it
 * sends equal to the text those pages show.
 */

import { useState, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import {
  registerStart,
  registerVerifyEmail,
  registerVerify,
  login,
} from "@/lib/api";
import { composeE164, DIALLING_CODES } from "@/lib/phone";
import { landingPath } from "@/lib/useRole";
import {
  PRIVACY_URL,
  PRIVACY_VERSION,
  TERMS_URL,
  TERMS_VERSION,
} from "@/lib/legal-versions";

type Step = "details" | "emailCode" | "smsCode";

function SignupForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const inviteToken = (searchParams.get("inviteToken") ?? "").trim();

  const [step, setStep] = useState<Step>("details");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [phonePrefix, setPhonePrefix] = useState("+64");
  const [phoneLocal, setPhoneLocal] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /**
   * ONE tick for BOTH documents, matching the mobile signup screen.
   *
   * Two checkboxes would present a choice that does not exist: declining either
   * one ends the signup, so offering them separately would be an interface
   * asking a question it will not accept an answer to. The API still records
   * them SEPARATELY -- one row per document, each with its own version -- which
   * is what lets one of them change later without reopening the other.
   */
  const [acceptedLegal, setAcceptedLegal] = useState(false);

  const normalizedEmail = email.trim().toLowerCase();

  const handleDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (phoneLocal.replace(/\D/g, "").length < 8) {
      setError("Please enter your full mobile number.");
      return;
    }
    if (password.length < 8) {
      setError("Please choose a password of at least 8 characters.");
      return;
    }
    // Checked here as well as by the disabled button, because a disabled button
    // is a presentation decision and somebody will restyle it. This is the
    // refusal; the button is the hint.
    if (!acceptedLegal) {
      setError("Please accept the Terms of Service and the Privacy Policy to continue.");
      return;
    }
    setLoading(true);
    try {
      await registerStart({
        email: normalizedEmail,
        // Composed here, where the dialling code and the local part are still
        // separate — the only place the trunk zero can be removed safely.
        phone: composeE164(phonePrefix, phoneLocal),
        fullName: fullName.trim(),
        password,
        acceptedTerms: true,
        acceptedPrivacy: true,
        // The version of each document THIS BUILD linked to, which is the only
        // version it can honestly claim was presented. Kept equal to the
        // canonical markdown by assert_legal_version_constant in
        // Projects/scripts/ci.sh, so it cannot drift from the text.
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
      });
      setNotice(`We have emailed a 6-digit code to ${normalizedEmail}.`);
      setStep("emailCode");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not start signup.");
    } finally {
      setLoading(false);
    }
  };

  const handleEmailCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await registerVerifyEmail(normalizedEmail, emailCode.trim());
      setNotice("Email confirmed. We have texted a 6-digit code to your mobile.");
      setStep("smsCode");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not confirm that code.");
    } finally {
      setLoading(false);
    }
  };

  const handleSmsCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const created = await registerVerify(normalizedEmail, smsCode.trim(), inviteToken);

      // The account now exists either way. /auth/register/verify treats a
      // not-found, expired or wrong-user invitation as NON-fatal: it still
      // returns 201, with a token carrying no company. Landing that person on
      // the dashboard would show them an empty app and no reason for it, so the
      // empty companyId is reported here instead of being navigated past.
      if (!created.user.companyId) {
        setError(
          "Your account was created, but the invitation could not be applied — it may have expired or already been used. Ask whoever invited you to send a new invitation, then open it from the email."
        );
        setLoading(false);
        return;
      }

      // Step 3 issues a bearer token and no cookie. This is what gives the
      // portal a session.
      await login(normalizedEmail, password);

      // This used to stop crew here, because crew ranked below the viewer gate
      // every portal route sat behind and /dashboard answered 403 to everything
      // it asked for. That gate was pathless and wrong (AUDIT L66); scoping it
      // gave crew back Sites, Reports, Activity and the live map, so there is
      // somewhere truthful to send them. landingPath() keeps them off the
      // dashboard, which is the one screen still not theirs.
      router.replace(landingPath(created.user.companyRole));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not complete signup.");
      setLoading(false);
    }
  };

  if (!inviteToken) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-logo">
            <Image src="/logo.png" alt="SiteSnap AI" width={56} height={56} style={{ borderRadius: 14 }} />
            <div>
              <div className="auth-title">SiteSnap AI</div>
              <div className="auth-sub">Manager Portal</div>
            </div>
          </div>
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              Accounts are created by invitation
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16 }}>
              To join a team, open the invitation link from your email. If you already have an
              account, sign in instead.
            </p>
            <Link href="/" style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
              ← Go to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <Image src="/logo.png" alt="SiteSnap AI" width={56} height={56} style={{ borderRadius: 14 }} />
          <div>
            <div className="auth-title">SiteSnap AI</div>
            <div className="auth-sub">Manager Portal</div>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
            Create your account
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Step {step === "details" ? 1 : step === "emailCode" ? 2 : 3} of 3
            {step === "details" ? " — your details" : step === "emailCode" ? " — confirm your email" : " — confirm your mobile"}
          </p>
        </div>

        {error && <div className="auth-error visible">{error}</div>}
        {!error && notice && (
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>{notice}</p>
        )}

        {step === "details" && (
          <form className="auth-form" onSubmit={handleDetails}>
            <div>
              <label className="field-label">Full name</label>
              <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
            </div>
            <div>
              <label className="field-label">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div>
              <label className="field-label">Mobile number</label>
              {/* Stacked, not side by side. A native select shows the selected
                  option's text truncated to the control width, and at 390px a
                  150px control cut "New Zealand +64" down to "New Zealand +(" —
                  losing the dialling code, which is the one part that must be
                  readable. Full width cannot truncate. The code also leads the
                  label so that it survives first if anything ever does. */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <select
                  value={phonePrefix}
                  onChange={(e) => setPhonePrefix(e.target.value)}
                  style={{ width: "100%" }}
                  aria-label="Country dialling code"
                >
                  {DIALLING_CODES.map((c) => (
                    <option key={`${c.label}-${c.code}`} value={c.code}>
                      {c.code} &nbsp;{c.label}
                    </option>
                  ))}
                </select>
                <input
                  type="tel"
                  value={phoneLocal}
                  onChange={(e) => setPhoneLocal(e.target.value)}
                  placeholder="021 555 0199"
                  autoComplete="tel-national"
                  style={{ width: "100%", minWidth: 0 }}
                  required
                />
              </div>
              <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 }}>
                Enter it as you would dial it at home. We will text you a code.
              </p>
            </div>
            <div>
              <label className="field-label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </div>
            {/* The consent control. Links open in a new tab rather than
                navigating: this form holds a password, a phone number and a
                name, and leaving the page would discard all three. The hosted
                pages are the portal's copies of these documents — it has no
                local ones, deliberately (see lib/legal-versions.ts). */}
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.45,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={acceptedLegal}
                onChange={(e) => setAcceptedLegal(e.target.checked)}
                style={{ width: 18, height: 18, marginTop: 1, flex: "0 0 auto" }}
              />
              <span>
                I have read and accept the{" "}
                <a
                  href={TERMS_URL}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)", fontWeight: 600 }}
                >
                  Terms of Service
                </a>{" "}
                and the{" "}
                <a
                  href={PRIVACY_URL}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)", fontWeight: 600 }}
                >
                  Privacy Policy
                </a>
                .
              </span>
            </label>
            <button
              type="submit"
              className="btn-primary"
              style={{ width: "100%", height: 46, opacity: acceptedLegal ? 1 : 0.55 }}
              disabled={loading || !acceptedLegal}
            >
              {loading ? "Sending code…" : "Continue"}
            </button>
          </form>
        )}

        {step === "emailCode" && (
          <form className="auth-form" onSubmit={handleEmailCode}>
            <div>
              <label className="field-label">Code from your email</label>
              <input
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
            </div>
            <button type="submit" className="btn-primary" style={{ width: "100%", height: 46 }} disabled={loading}>
              {loading ? "Checking…" : "Confirm email"}
            </button>
          </form>
        )}

        {step === "smsCode" && (
          <form className="auth-form" onSubmit={handleSmsCode}>
            <div>
              <label className="field-label">Code from your text message</label>
              <input
                value={smsCode}
                onChange={(e) => setSmsCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
              />
            </div>
            <button type="submit" className="btn-primary" style={{ width: "100%", height: 46 }} disabled={loading}>
              {loading ? "Creating your account…" : "Create account"}
            </button>
          </form>
        )}

        <div style={{ textAlign: "center", marginTop: 14 }}>
          <Link href="/" style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
            Already have an account? Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
