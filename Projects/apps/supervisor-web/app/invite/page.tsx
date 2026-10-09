"use client";

/**
 * The portal's accept-invitation route.
 *
 * It did not exist. An invitation email carries one URL, that URL is opened in
 * whatever the recipient has to hand, and on a desktop browser it reached the
 * portal, which had no /invite route and no /signup route — so the journey
 * ended at a 404 for everybody who was not already a user. This is hop 5 of the
 * trace in docs/PHASE-1-INVITATION-TRACE.md.
 *
 * The page does not accept the invitation by itself, because it cannot: the
 * accept route needs a session, and an invitee by definition may not have an
 * account yet. So it sorts the recipient into the two cases that actually
 * exist, keeping the token attached across whichever one they take:
 *
 *   - no account      -> /signup?inviteToken=…, which registers them and
 *                        consumes the invitation in the same request
 *   - has an account  -> sign in here, then accept with the new session
 *
 * The second is handled inline rather than by bouncing to the sign-in page and
 * back. A redirect to `/` would drop the token from the URL, and the sign-in
 * page has nowhere to put it.
 */

import { useState, Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { login, acceptInvite } from "@/lib/api";

function InviteForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token") ?? "";

  const [mode, setMode] = useState<"choose" | "signin">("choose");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState<{ siteName: string | null } | null>(null);

  const handleSignInAndAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Sign in first: the accept route reads the session cookie, and this is
      // the call that sets it.
      await login(email.trim().toLowerCase(), password);
      const result = await acceptInvite(token);
      setAccepted({ siteName: result.siteName });
      setTimeout(() => router.replace("/dashboard"), 2000);
    } catch (err: unknown) {
      // Deliberately not a redirect. Signing in may have succeeded while
      // acceptance failed — an expired or already-used invitation — and in that
      // case the person does have a working session and should be told what
      // happened rather than silently landed somewhere.
      setError(err instanceof Error ? err.message : "Could not accept the invitation.");
    } finally {
      setLoading(false);
    }
  };

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

        {!token ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              This invitation link is incomplete
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16 }}>
              The link is missing its invitation code. Open the link from your invitation email
              again, or ask whoever invited you to send another.
            </p>
            <Link href="/" style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
              ← Go to sign in
            </Link>
          </div>
        ) : accepted ? (
          <div style={{ textAlign: "center", padding: "16px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              Invitation accepted
            </h2>
            <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>
              {accepted.siteName
                ? `You now have access to ${accepted.siteName}. Taking you to the portal…`
                : "You have joined the team. Taking you to the portal…"}
            </p>
          </div>
        ) : mode === "choose" ? (
          <div className="auth-form">
            <div style={{ marginBottom: 8 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                You have been invited to SiteSnap
              </h2>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                To accept, you need a SiteSnap account. Which applies to you?
              </p>
            </div>

            <Link
              href={`/signup?inviteToken=${encodeURIComponent(token)}`}
              className="btn-primary"
              style={{
                width: "100%", height: 46, display: "flex", alignItems: "center",
                justifyContent: "center", textDecoration: "none",
              }}
            >
              Create my account
            </Link>

            <button
              type="button"
              onClick={() => setMode("signin")}
              style={{
                width: "100%", height: 46, background: "transparent",
                border: "1px solid var(--border)", borderRadius: 10,
                color: "var(--text)", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}
            >
              I already have an account
            </button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSignInAndAccept}>
            <div style={{ marginBottom: 8 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
                Sign in to accept
              </h2>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Signing in will add this invitation to your account.
              </p>
            </div>

            {error && <div className="auth-error visible">{error}</div>}

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
              <label className="field-label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            <button type="submit" className="btn-primary" style={{ width: "100%", height: 46 }} disabled={loading}>
              {loading ? "Accepting…" : "Sign in and accept"}
            </button>

            <div style={{ textAlign: "center" }}>
              <button
                type="button"
                onClick={() => { setMode("choose"); setError(""); }}
                style={{
                  background: "none", border: "none", color: "var(--accent)",
                  fontSize: 13, fontWeight: 600, cursor: "pointer",
                }}
              >
                ← Back
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense>
      <InviteForm />
    </Suspense>
  );
}
