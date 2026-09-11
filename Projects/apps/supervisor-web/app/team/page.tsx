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
import type { CompanyProfile, CompanyMember } from "@/lib/api";

const ROLE_CFG: Record<string, { label: string; color: string; bg: string }> = {
  owner:   { label: "Owner",   color: "#7C3AED", bg: "#F5F3FF" },
  manager: { label: "Manager", color: "#E8731A", bg: "#FFF7ED" },
  viewer:  { label: "Viewer",  color: "#0EA5E9", bg: "#F0F9FF" },
  crew:    { label: "Crew",    color: "#22C55E", bg: "#F0FDF4" },
};

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLE_CFG[role] ?? { label: role, color: "#9EAFC2", bg: "#F1F5F9" };
  return (
    <span className="badge" style={{ background: cfg.bg, color: cfg.color, fontWeight: 700 }}>
      {cfg.label}
    </span>
  );
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
  const [inviteResults, setInviteResults] = useState<{ email: string; status: string }[]>([]);
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
    const emails = inviteEmails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
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
      <Sidebar userName={user?.name ?? user?.email ?? "Supervisor"} />
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
                      <div style={{ background: "#F0FDF4", color: "#166534", borderRadius: 8, padding: "10px 14px", fontSize: 13 }}>
                        {inviteResults.map((r) => (
                          <div key={r.email}>✓ {r.email} — {r.status === "sent" ? "Invitation sent" : r.status}</div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 240 }}>
                        <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 5 }}>
                          Email addresses
                        </label>
                        <input
                          type="text"
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
