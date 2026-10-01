"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { login, isAuthenticated } from "@/lib/api";
import { analytics } from "@/lib/analytics";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) router.replace("/dashboard");
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) { setError("Email and password are required."); return; }
    setError("");
    setLoading(true);
    try {
      const data = await login(email.trim().toLowerCase(), password);
      analytics.identify(data.user.email, data.user.role);
      analytics.loginSuccess(data.user.role);
      router.replace("/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* Brand mark above card */}
      <div className="auth-brand">
        <div className="auth-brand-logo">
          <Image src="/logo.png" alt="SiteSnap AI" width={72} height={72} style={{ objectFit: "cover" }} onError={() => {}} />
        </div>
        <div style={{ textAlign: "center" }}>
          <div className="auth-brand-name">SiteSnap AI</div>
          <div className="auth-brand-sub">Manager Portal</div>
        </div>
      </div>

      <div className="auth-card">
        <div className="auth-card-title">Welcome back</div>
        <div className="auth-card-sub">Sign in to manage your construction portfolio</div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {error && <div className="auth-error visible">{error}</div>}

          <div>
            <label className="field-label">Email address</label>
            <input
              type="email"
              placeholder="supervisor@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <label className="field-label" style={{ margin: 0 }}>Password</label>
              <Link href="/forgot-password" style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
                Forgot password?
              </Link>
            </div>
            <div style={{ position: "relative" }}>
              <input
                type={showPw ? "text" : "password"}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                style={{ paddingRight: 44 }}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                style={{
                  position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", cursor: "pointer", padding: 4,
                  color: "var(--text-tertiary)", fontSize: 18, lineHeight: 1,
                }}
                aria-label={showPw ? "Hide password" : "Show password"}
              >
                {showPw ? "🙈" : "👁"}
              </button>
            </div>
          </div>

          <button type="submit" className="auth-submit" disabled={loading}
            style={{ background: loading ? "var(--primary-light)" : "var(--accent)" }}>
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <p style={{ marginTop: 20, textAlign: "center", fontSize: 12, color: "var(--text-tertiary)" }}>
          Owner and manager accounts only.
        </p>
      </div>
    </div>
  );
}
