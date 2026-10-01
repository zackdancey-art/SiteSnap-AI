"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSavedUser, saveUser, logout } from "@/lib/api";
import type { User } from "@/lib/api";
import { companyRoleLabel } from "@/lib/roles";

export default function ProfileDropdown() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [editName, setEditName] = useState("");
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const roleLabel = companyRoleLabel(user?.companyRole);

  useEffect(() => {
    const u = getSavedUser();
    setUser(u);
    setEditName(u?.name ?? "");
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleSaveName = () => {
    if (!user || !editName.trim()) return;
    const updated = { ...user, name: editName.trim() };
    saveUser(updated);
    setUser(updated);
    setSaved(true);
    setEditing(false);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSignOut = async () => {
    await logout();
    router.replace("/");
  };

  const initials = (user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {/* Avatar button */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 38, height: 38, borderRadius: "50%",
          background: open ? "var(--accent)" : "var(--primary)",
          color: "#fff", fontWeight: 700, fontSize: 15,
          border: open ? "2px solid var(--accent)" : "2px solid rgba(255,255,255,0.15)",
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.15s, border-color 0.15s",
          flexShrink: 0,
        }}
      >
        {initials}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 10px)", right: 0,
          width: 300, background: "#fff",
          borderRadius: 14, boxShadow: "0 8px 40px rgba(15,43,70,0.18), 0 2px 8px rgba(0,0,0,0.08)",
          border: "1px solid var(--border)",
          zIndex: 500, overflow: "hidden",
        }}>

          {/* Profile header */}
          <div style={{ background: "var(--primary)", padding: "20px 20px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{
                width: 52, height: 52, borderRadius: "50%",
                background: "var(--accent)", display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 22, fontWeight: 800, color: "#fff",
                flexShrink: 0, border: "3px solid rgba(255,255,255,0.2)",
              }}>
                {initials}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {user?.name ?? "Manager"}
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {user?.email}
                </div>
                {/* Was `user?.role?.toUpperCase() ?? "SUPERVISOR"`: the DEPRECATED
                    legacy role (worker/supervisor/admin), so a manager's badge read
                    "SUPERVISOR" here and "Manager" on the team page — two words for
                    one role in one session. Now the company role through the shared
                    label map, and nothing at all when the role is unknown, rather
                    than a default that asserts permissions we cannot support. */}
                {roleLabel && (
                  <div style={{ marginTop: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, background: "var(--accent)", color: "#fff", padding: "2px 8px", borderRadius: 6, letterSpacing: "0.05em" }}>
                      {roleLabel.toUpperCase()}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Edit name */}
          <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              Display Name
            </div>
            {editing ? (
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); if (e.key === "Escape") setEditing(false); }}
                  style={{ flex: 1, height: 34, fontSize: 13, borderRadius: 7, border: "1.5px solid var(--accent)", padding: "0 10px" }}
                />
                <button onClick={handleSaveName} style={{ height: 34, padding: "0 12px", borderRadius: 7, background: "var(--accent)", color: "#fff", border: "none", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Save</button>
                <button onClick={() => setEditing(false)} style={{ height: 34, padding: "0 10px", borderRadius: 7, background: "var(--surface-secondary)", color: "var(--text-secondary)", border: "none", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>✕</button>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  {saved ? "✓ Saved" : (user?.name ?? "—")}
                </span>
                <button onClick={() => setEditing(true)} style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, background: "none", border: "none", cursor: "pointer", padding: "4px 6px" }}>
                  Edit
                </button>
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div style={{ padding: "8px 8px" }}>
            {[
              { label: "Settings", icon: "⚙️", href: "/settings" },
              { label: "Change password", icon: "🔑", href: "/settings" },
              { label: "Privacy Policy", icon: "🔒", href: "/privacy" },
            ].map(({ label, icon, href }) => (
              <button
                key={label}
                onClick={() => { setOpen(false); router.push(href); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  width: "100%", padding: "9px 12px", borderRadius: 8,
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 500, color: "var(--text-secondary)",
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: 15, lineHeight: 1 }}>{icon}</span>
                {label}
              </button>
            ))}
          </div>

          {/* Sign out */}
          <div style={{ padding: "8px 8px 10px", borderTop: "1px solid var(--border)" }}>
            <button
              onClick={handleSignOut}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                width: "100%", padding: "9px 12px", borderRadius: 8,
                background: "none", border: "none", cursor: "pointer",
                fontSize: 13, fontWeight: 700, color: "var(--error)",
                textAlign: "left",
              }}
            >
              <span style={{ fontSize: 15 }}>↩</span>
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
