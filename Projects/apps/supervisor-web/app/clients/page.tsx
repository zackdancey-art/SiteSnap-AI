"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { SkeletonCard } from "@/components/Skeleton";
import {
  getSavedUser,
  listClients,
  createClient,
  updateClient,
  deleteClient,
  type Client,
  type ClientInput,
} from "@/lib/api";
import { useRole } from "@/lib/useRole";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLIENTS. FILING, NOT AN ACCESS BOUNDARY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lists the company's clients with how many sites each holds, and for a manager
 * or owner adds, renames and deletes them.
 *
 * READ-ONLY FOR CREW, ON PURPOSE. GET /clients is behind identity rather than
 * rank because the sites list takes its group headings from it, so this page is
 * theirs to read and the three write controls are simply absent — not drawn and
 * disabled. A disabled control still names an action and still invites a click;
 * what it does not do is explain itself. (AUDIT L79 is the same mistake in the
 * other direction: a whole page withheld to keep back one section.)
 *
 * DELETING UNFILES. It is the one control here that looks destructive and is
 * not: the client's sites lose their filing and none of them, nor any entry,
 * diary or photograph, is deleted. The confirmation says that in those words
 * with the real count, and the result reports the number the SERVER unfiled
 * rather than the one this page predicted — they disagree whenever another
 * session filed a site between the list loading and the click.
 */
export default function ClientsPage() {
  const user = getSavedUser();
  const { canManageClients } = useRole();

  const [clients, setClients] = useState<Client[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Client | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ClientInput>(emptyForm());
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setClients(await listClients());
      setLoadError(null);
    } catch (e) {
      /**
       * Reported, not swallowed into an empty list.
       *
       * An empty list and a failed request look identical on screen and mean
       * opposite things: one says "nobody has added a client", the other says
       * "we do not know". The mobile half makes the same distinction with a
       * null sentinel for the same reason.
       */
      setLoadError(e instanceof Error ? e.message : "Could not load clients.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => {
    setForm(emptyForm());
    setEditing(null);
    setFormError(null);
    setShowForm(true);
  };

  const openEdit = (client: Client) => {
    setForm({
      name: client.name,
      contactName: client.contactName,
      contactEmail: client.contactEmail,
      contactPhone: client.contactPhone,
      notes: client.notes,
    });
    setEditing(client);
    setFormError(null);
    setShowForm(true);
  };

  const submit = async () => {
    const name = form.name.trim();
    if (!name) {
      setFormError("A client needs a name. Everything else is optional.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload: ClientInput = {
        name,
        contactName: form.contactName.trim(),
        contactEmail: form.contactEmail.trim(),
        contactPhone: form.contactPhone.trim(),
        notes: form.notes.trim(),
      };
      if (editing) {
        const updated = await updateClient(editing.id, payload);
        // siteCount is carried over: PATCH /clients/:id answers `{ client }`
        // without it, and an undefined there is what would make the delete
        // confirmation below misstate how many sites are about to be unfiled.
        setClients((prev) =>
          sortByName(
            (prev ?? []).map((c) => (c.id === updated.id ? { ...updated, siteCount: c.siteCount } : c))
          )
        );
      } else {
        const created = await createClient(payload);
        setClients((prev) => sortByName([...(prev ?? []), created]));
      }
      setShowForm(false);
    } catch (e) {
      /**
       * The 409 is branched on its STATUS, not by reading the prose.
       *
       * The wording is the server's to change; the status is the contract. The
       * portal already has one screen that picked its message by searching an
       * error string for tokens no response body contained (app/invite.tsx,
       * which is why `request` now carries the status out at all).
       */
      const status = (e as { status?: unknown } | null)?.status;
      setFormError(
        status === 409
          ? `You already have a client called "${name}".`
          : e instanceof Error ? e.message : "Could not save this client."
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (client: Client) => {
    const siteWord = client.siteCount === 1 ? "site" : "sites";
    const warning =
      client.siteCount > 0
        ? `Delete ${client.name}?\n\nIts ${client.siteCount} ${siteWord} will become unfiled. ` +
          `No site, entry, diary or photograph is deleted.`
        : `Delete ${client.name}?\n\nThis client has no sites filed under it.`;
    if (!window.confirm(warning)) return;
    try {
      const unfiled = await deleteClient(client.id);
      setClients((prev) => (prev ?? []).filter((c) => c.id !== client.id));
      setNotice(
        unfiled > 0
          ? `${client.name} deleted. ${unfiled} ${unfiled === 1 ? "site is" : "sites are"} now unfiled.`
          : `${client.name} deleted.`
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not delete this client.");
    }
  };

  const loading = clients === null && loadError === null;

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />
      <div className="main">
        <Topbar title="Clients" />
        <div className="page-body">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", flex: 1, minWidth: 240 }}>
              Clients group your sites for filing and reporting. A site with no client stays
              visible as <strong>Unfiled</strong> — nothing is hidden by not filing it.
            </p>
            {canManageClients && (
              <button className="btn-primary" onClick={openCreate} style={{ flexShrink: 0 }}>
                + New client
              </button>
            )}
          </div>

          {notice && (
            <div
              style={{
                padding: "10px 14px", borderRadius: 8, fontSize: 13,
                background: "var(--surface)", border: "1.5px solid var(--border)",
                display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center",
              }}
            >
              <span>{notice}</span>
              <button
                onClick={() => setNotice(null)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-tertiary)" }}
              >
                ✕
              </button>
            </div>
          )}

          {loadError && (
            <p style={{ color: "var(--error, #ef4444)", padding: "16px 0", fontSize: 13 }}>
              ⚠️ {loadError}{" "}
              <button
                onClick={() => { setClients(null); void load(); }}
                style={{ background: "none", border: "none", textDecoration: "underline", cursor: "pointer", color: "inherit", font: "inherit" }}
              >
                Try again
              </button>
            </p>
          )}

          {loading && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} rows={2} />)}
            </div>
          )}

          {clients !== null && clients.length === 0 && (
            <div className="card" style={{ padding: 32, textAlign: "center" }}>
              <p style={{ fontSize: 15, fontWeight: 600, margin: "0 0 6px" }}>No clients yet</p>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
                {canManageClients
                  ? "Add a client, then file sites under it from the Sites page."
                  : "Nobody has added a client yet. Sites show as Unfiled until one is added."}
              </p>
            </div>
          )}

          {clients !== null && clients.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {clients.map((client) => (
                <div className="card" key={client.id} style={{ padding: "16px 18px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0, flex: 1 }}>{client.name}</h3>
                    {canManageClients && (
                      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        <button
                          onClick={() => openEdit(client)}
                          title="Edit client"
                          style={iconBtn}
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => void remove(client)}
                          title="Delete client — its sites are unfiled, not deleted"
                          style={{ ...iconBtn, color: "var(--error, #ef4444)" }}
                        >
                          🗑
                        </button>
                      </div>
                    )}
                  </div>

                  {/* The site count links to the filtered sites list rather than
                      only stating a number: "4 sites" is the one thing on this
                      card somebody will want to act on. */}
                  <Link
                    href={`/sites?clientId=${encodeURIComponent(client.id)}`}
                    style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}
                  >
                    {client.siteCount} {client.siteCount === 1 ? "site" : "sites"} →
                  </Link>

                  {/* Each contact line is conditional. A client added mid-job has
                      a name and nothing else, and empty labelled rows read as
                      missing data rather than as data nobody entered. */}
                  {(client.contactName || client.contactEmail || client.contactPhone || client.notes) && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "grid", gap: 4 }}>
                      {client.contactName && <Detail label="Contact" value={client.contactName} />}
                      {client.contactEmail && <Detail label="Email" value={client.contactEmail} />}
                      {client.contactPhone && <Detail label="Phone" value={client.contactPhone} />}
                      {client.notes && <Detail label="Notes" value={client.notes} />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showForm && (
        <div style={modalBackdrop} onClick={() => !saving && setShowForm(false)}>
          <div className="card" style={modalCard} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 14px" }}>
              {editing ? `Edit ${editing.name}` : "New client"}
            </h2>
            <div style={{ display: "grid", gap: 12 }}>
              <Field label="Name" value={form.name} onChange={(name) => setForm((f) => ({ ...f, name }))} />
              <Field label="Contact name" value={form.contactName} onChange={(contactName) => setForm((f) => ({ ...f, contactName }))} optional />
              <Field label="Email" value={form.contactEmail} onChange={(contactEmail) => setForm((f) => ({ ...f, contactEmail }))} optional type="email" />
              <Field label="Phone" value={form.contactPhone} onChange={(contactPhone) => setForm((f) => ({ ...f, contactPhone }))} optional type="tel" />
              <Field label="Notes" value={form.notes} onChange={(notes) => setForm((f) => ({ ...f, notes }))} optional multiline />
            </div>
            {formError && (
              <p style={{ color: "var(--error, #ef4444)", fontSize: 13, margin: "12px 0 0" }}>{formError}</p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={() => setShowForm(false)} disabled={saving} style={iconBtnWide}>Cancel</button>
              <button className="btn-primary" onClick={() => void submit()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function emptyForm(): ClientInput {
  return { name: "", contactName: "", contactEmail: "", contactPhone: "", notes: "" };
}

function sortByName(list: Client[]): Client[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
      <span style={{ color: "var(--text-tertiary)", minWidth: 58 }}>{label}</span>
      <span style={{ color: "var(--text-secondary)", wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

function Field({
  label, value, onChange, optional, type, multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  type?: string;
  multiline?: boolean;
}) {
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
        {label}{optional && <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}> (optional)</span>}
      </span>
      {multiline ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} style={{ fontSize: 13, resize: "vertical" }} />
      ) : (
        <input type={type ?? "text"} value={value} onChange={(e) => onChange(e.target.value)} style={{ fontSize: 13, height: 36 }} />
      )}
    </label>
  );
}

const iconBtn: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 6, cursor: "pointer",
  background: "var(--surface)", border: "1.5px solid var(--border)",
  color: "var(--text-secondary)", fontSize: 13, lineHeight: 1,
};

const iconBtnWide: React.CSSProperties = {
  padding: "8px 16px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
  background: "var(--surface)", border: "1.5px solid var(--border)", color: "var(--text-secondary)",
};

const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(15,43,70,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50,
};

const modalCard: React.CSSProperties = {
  width: "100%", maxWidth: 440, padding: 20, maxHeight: "86vh", overflowY: "auto",
};
