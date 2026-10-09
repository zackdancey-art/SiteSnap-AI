"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { SkeletonCard } from "@/components/Skeleton";
import {
  getSavedUser, isAuthenticated,
  fetchCompanyProfile, updateCompanyProfile,
  listCompanyMembers, inviteCompanyMembers,
  updateMemberRole, removeCompanyMember,
} from "@/lib/api";
import { useRole } from "@/lib/useRole";
import { COMPANY_ROLE_LABELS } from "@/lib/roles";
import type { CompanyProfile, CompanyMember, CompanyInviteResult } from "@/lib/api";

// The labels come from lib/roles so this file and ProfileDropdown cannot drift
// into two vocabularies again; the colours stay local, they are only used here.
const ROLE_CFG: Record<string, { label: string; color: string; bg: string }> = {
  owner:   { label: COMPANY_ROLE_LABELS.owner,   color: "#7C3AED", bg: "#F5F3FF" },
  manager: { label: COMPANY_ROLE_LABELS.manager, color: "#E8731A", bg: "#FFF7ED" },
  viewer:  { label: COMPANY_ROLE_LABELS.viewer,  color: "#0EA5E9", bg: "#F0F9FF" },
  crew:    { label: COMPANY_ROLE_LABELS.crew,    color: "#22C55E", bg: "#F0FDF4" },
};

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLE_CFG[role] ?? { label: role, color: "#9EAFC2", bg: "#F1F5F9" };
  return (
    <span className="badge" style={{ background: cfg.bg, color: cfg.color, fontWeight: 700 }}>
      {cfg.label}
    </span>
  );
}

/**
 * One description per invitation outcome, derived from the WHOLE result.
 *
 * What was here before rendered every result inside one green box as
 * `✓ {email} — {status === "sent" ? "Invitation sent" : status}`. Three things
 * were wrong with that, in rising order of consequence:
 *
 *  - it printed the raw enum, so re-inviting someone showed
 *    "✓ alice@example.com — resent" and an existing team member showed
 *    "✓ alice@example.com — already_member";
 *  - it gave every outcome a tick and a green background, including the ones
 *    that are not successes;
 *  - it ignored `delivered`, which the route reports separately from `status`
 *    — so an invitation whose email failed to send read as "Invitation sent".
 *
 * Colours come from the existing tokens and the tints already used in this
 * file; the message itself is `var(--text)` on every tint, because the accent
 * orange on a cream tint does not carry enough contrast to be read.
 */
function describeInvite(r: CompanyInviteResult): { glyph: string; color: string; bg: string; label: string } {
  if (r.status === "error") {
    return { glyph: "✕", color: "var(--error)", bg: "#FEE2E2", label: "Could not create the invitation" };
  }
  if (r.status === "already_member") {
    return { glyph: "—", color: "var(--text-secondary)", bg: "#F1F5F9", label: "Already in your team — no invitation needed" };
  }
  if (r.delivered === false) {
    // The re-send case has to keep its warning about the old link. Falling
    // through to one shared undelivered message would drop it, and the old
    // link is dead either way — the email failing does not bring it back.
    return {
      glyph: "!",
      color: "var(--warning)",
      bg: "#FFF7ED",
      label: r.status === "resent"
        ? "Invitation re-issued, but the email could not be sent — any earlier link for this address has stopped working"
        : "Invitation created, but the email could not be sent",
    };
  }
  if (r.status === "resent") {
    return {
      glyph: "✓",
      color: "var(--success)",
      bg: "#F0FDF4",
      label: "Invitation re-sent — any earlier link for this address has stopped working",
    };
  }
  return { glyph: "✓", color: "var(--success)", bg: "#F0FDF4", label: "Invitation sent" };
}

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>{title}</h2>
        {description && <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "4px 0 0", lineHeight: 1.5 }}>{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export default function TeamPage() {
  const router = useRouter();
  const user = getSavedUser();
  const { companyRole, isOwner, isManager } = useRole();

  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Company profile editing
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [nameSaving, setNameSaving] = useState(false);

  // Invite form
  const [inviteEmails, setInviteEmails] = useState("");
  const [inviteRole, setInviteRole] = useState<"manager" | "viewer" | "crew">("viewer");
  const [inviting, setInviting] = useState(false);
  const [inviteResults, setInviteResults] = useState<CompanyInviteResult[]>([]);
  const [inviteError, setInviteError] = useState("");

  // Per-member state
  const [roleChanging, setRoleChanging] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [profile, memberList] = await Promise.all([
        fetchCompanyProfile(),
        isManager ? listCompanyMembers() : Promise.resolve([] as CompanyMember[]),
      ]);
      setCompany(profile);
      setNameInput(profile.name);
      setMembers(memberList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load team data.");
    } finally {
      setLoading(false);
    }
  }, [isManager]);

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/"); return; }
    load();
  }, [router, load]);

  const saveName = async () => {
    if (!nameInput.trim()) return;
    setNameSaving(true);
    try {
      const updated = await updateCompanyProfile({ name: nameInput.trim() });
      setCompany(updated);
      setEditingName(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update company name.");
    } finally {
      setNameSaving(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError("");
    setInviteResults([]);
    // Lowercased before it leaves the browser. AUDIT L46: the API stores an
    // invited address exactly as typed, while registration lowercases, and
    // acceptance compares the two with string equality — so a capitalised
    // invitation is refused `wrong_user`, which tells the right person the
    // invitation is for somebody else. Fixing the comparison properly needs a
    // backfill migration; normalising here stops new bad invitations being
    // created and costs nothing. The mobile invite screens already do this.
    const emails = inviteEmails
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length === 0) { setInviteError("Enter at least one email address."); return; }
    setInviting(true);
    try {
      const { results } = await inviteCompanyMembers(emails, inviteRole);
      setInviteResults(results);
      setInviteEmails("");
      await load();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to send invitations.");
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (email: string, newRole: string) => {
    setRoleChanging(email);
    try {
      await updateMemberRole(email, newRole);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to change role.");
    } finally {
      setRoleChanging(null);
    }
  };

  const handleRemove = async (email: string) => {
    if (!confirm(`Remove ${email} from the company? They will lose access to all company sites.`)) return;
    setRemoving(email);
    try {
      await removeCompanyMember(email);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove member.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />
      <div className="main">
        <Topbar title="Team" right={<RoleBadge role={companyRole} />} />

        <div className="page-body" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {error && (
            <p style={{ color: "var(--error)", padding: "16px 0" }}>
              ⚠️ {error} — <a href="/" style={{ color: "inherit" }}>Sign in again</a>
            </p>
          )}

          {loading && <SkeletonCard rows={4} />}

          {!loading && company && (
            <>
              {/* Company profile */}
              <Panel title="Company" description="Your company details. The name appears on all exported reports.">
                <div style={{ padding: "16px 22px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                  {!editingName ? (
                    <>
                      <span style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", flex: 1 }}>{company.name}</span>
                      {isOwner && (
                        <button
                          className="btn-ghost"
                          onClick={() => { setNameInput(company.name); setEditingName(true); }}
                          style={{ padding: "6px 16px", fontSize: 13, borderRadius: 8, border: "1.5px solid var(--border)", background: "none", cursor: "pointer", color: "var(--text-secondary)", fontWeight: 600 }}
                        >
                          Edit
                        </button>
                      )}
                    </>
                  ) : (
                    <div style={{ display: "flex", gap: 10, flex: 1, flexWrap: "wrap" }}>
                      <input
                        type="text"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        autoFocus
                        style={{ height: 38, fontSize: 14, borderRadius: 8, flex: 1, maxWidth: 380 }}
                      />
                      <button className="btn-primary" onClick={saveName} disabled={nameSaving} style={{ padding: "0 18px" }}>
                        {nameSaving ? "Saving…" : "Save"}
                      </button>
                      <button onClick={() => setEditingName(false)} style={{ padding: "0 14px", borderRadius: 8, border: "1.5px solid var(--border)", background: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </Panel>

              {/* Members table — manager+ */}
              {isManager && (
                <Panel title="Members" description="Everyone in your company with access to SiteSnap.">
                  {members.length === 0 ? (
                    <div className="empty-state"><p>No members yet.</p></div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                        <thead>
                          <tr style={{ borderBottom: "1px solid var(--border)" }}>
                            {["Name", "Email", "Role", ...(isOwner ? ["Actions"] : [])].map((h) => (
                              <th key={h} style={{ padding: "10px 22px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {members.map((m, i) => (
                            <tr key={m.email} style={{ borderBottom: i < members.length - 1 ? "1px solid var(--border)" : "none" }}>
                              <td style={{ padding: "12px 22px", fontWeight: 600 }}>
                                {m.name || "—"}
                                {m.email === user?.email && (
                                  <span style={{ fontSize: 11, color: "var(--text-secondary)", marginLeft: 8, fontWeight: 400 }}>(you)</span>
                                )}
                              </td>
                              <td style={{ padding: "12px 22px", color: "var(--text-secondary)", fontSize: 13 }}>{m.email}</td>
                              <td style={{ padding: "12px 22px" }}>
                                {isOwner && m.email !== user?.email ? (
                                  <select
                                    value={m.companyRole}
                                    onChange={(e) => handleRoleChange(m.email, e.target.value)}
                                    disabled={roleChanging === m.email}
                                    style={{ height: 32, fontSize: 13, borderRadius: 8, border: "1.5px solid var(--border)", padding: "0 8px", background: "var(--surface)", color: "var(--text)", cursor: "pointer" }}
                                  >
                                    <option value="owner">Owner</option>
                                    <option value="manager">Manager</option>
                                    <option value="viewer">Viewer</option>
                                    <option value="crew">Crew</option>
                                  </select>
                                ) : (
                                  <RoleBadge role={m.companyRole} />
                                )}
                              </td>
                              {isOwner && (
                                <td style={{ padding: "12px 22px" }}>
                                  {m.email !== user?.email && (
                                    <button
                                      onClick={() => handleRemove(m.email)}
                                      disabled={removing === m.email}
                                      style={{ fontSize: 12, fontWeight: 600, color: "var(--error)", background: "none", border: "1.5px solid #FCA5A5", borderRadius: 6, padding: "4px 12px", cursor: "pointer" }}
                                    >
                                      {removing === m.email ? "Removing…" : "Remove"}
                                    </button>
                                  )}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              )}

              {/* Invite form — owner only */}
              {isOwner && (
                <Panel title="Invite people" description="Send company invitations. Invitees will be prompted to create an account if they don't have one.">
                  <form onSubmit={handleInvite} style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
                    {inviteError && (
                      <div style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>{inviteError}</div>
                    )}
                    {inviteResults.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {inviteResults.map((r) => {
                          const d = describeInvite(r);
                          return (
                            <div
                              key={r.email}
                              style={{
                                background: d.bg,
                                color: "var(--text)",
                                borderLeft: `3px solid ${d.color}`,
                                borderRadius: 8,
                                padding: "10px 14px",
                                fontSize: 13,
                                display: "flex",
                                gap: 10,
                                alignItems: "flex-start",
                              }}
                            >
                              <span aria-hidden="true" style={{ color: d.color, fontWeight: 700, lineHeight: "1.4" }}>{d.glyph}</span>
                              <span style={{ lineHeight: 1.4 }}>
                                <strong style={{ fontWeight: 600 }}>{r.email}</strong>
                                <br />
                                {d.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 240 }}>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                          Email addresses
                        </label>
                        {/*
                          autoCapitalize/autoCorrect/spellCheck are not cosmetic
                          here. iOS Safari defaults a type="text" input to
                          sentence capitalisation, so a supervisor inviting crew
                          from an iPad produced "Alice@example.com" every time —
                          and AUDIT L46 then refused the invitation. type stays
                          "text" rather than "email" because this field takes
                          several addresses and the browser's single-address
                          validation would reject the list; inputMode gives the
                          email keyboard without it.
                        */}
                        <input
                          type="text"
                          inputMode="email"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          value={inviteEmails}
                          onChange={(e) => setInviteEmails(e.target.value)}
                          placeholder="alice@example.com, bob@example.com"
                          style={{ height: 38, fontSize: 13, borderRadius: 8, width: "100%" }}
                        />
                        <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 4 }}>Separate multiple addresses with commas or spaces.</p>
                      </div>
                      <div>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                          Role
                        </label>
                        <select
                          value={inviteRole}
                          onChange={(e) => setInviteRole(e.target.value as "manager" | "viewer" | "crew")}
                          style={{ height: 38, fontSize: 13, borderRadius: 8, border: "1.5px solid var(--border)", padding: "0 10px", background: "var(--surface)", color: "var(--text)", cursor: "pointer", width: 140 }}
                        >
                          <option value="manager">Manager</option>
                          <option value="viewer">Viewer</option>
                          <option value="crew">Crew (mobile)</option>
                        </select>
                      </div>
                    </div>
                    <button type="submit" className="btn-primary" disabled={inviting} style={{ alignSelf: "flex-start", padding: "8px 22px" }}>
                      {inviting ? "Sending…" : "Send invitations"}
                    </button>
                  </form>
                </Panel>
              )}

              {/* Role guide */}
              <Panel title="Role guide" description="What each role can do in SiteSnap.">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 0 }}>
                  {[
                    { role: "owner",   perms: ["Full company admin", "Invite & remove members", "Edit company profile", "All manager permissions"] },
                    { role: "manager", perms: ["Create & delete sites", "Manage site members", "View all reports", "Approve diaries"] },
                    { role: "viewer",  perms: ["View all sites & data", "Download reports", "Read-only dashboard"] },
                    { role: "crew",    perms: ["Mobile app only", "Log site entries & photos", "Submit timecards", "Report incidents"] },
                  ].map(({ role, perms }) => (
                    <div key={role} style={{ padding: "16px 22px", borderRight: "1px solid var(--border)" }}>
                      <RoleBadge role={role} />
                      <ul style={{ margin: "10px 0 0", padding: "0 0 0 16px", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.8 }}>
                        {perms.map((p) => <li key={p}>{p}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
