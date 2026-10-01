import { Actor } from "./actor";
import { withTenant } from "./tenant";

/**
 * Ownership record for uploaded media (finding H7). The owning company is bound
 * at UPLOAD time from the authenticated uploader's identity — a place the
 * requester cannot forge — NOT inferred from caller-writable entry photo JSON.
 * `uploadBelongsToActorCompany` returns true only when the row's company matches
 * the caller's, and it asserts that in the query itself; the FORCE RLS policy on
 * the `uploads` table (migration 023) is a second layer behind it, not the only
 * one. See the comment on that function for why the distinction matters.
 */
type UploadMeta = {
  id: string;
  companyId: string;
  ownerEmail: string;
  filename: string;
  createdAt: string;
};

function useDatabase() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

const memoryUploads = new Map<string, UploadMeta>();

/** Record the owning company of an upload at upload time (unforgeable). */
export async function recordUpload(actor: Actor, id: string, filename: string): Promise<void> {
  if (!useDatabase()) {
    if (!memoryUploads.has(id)) {
      memoryUploads.set(id, {
        id,
        companyId: actor.companyId,
        ownerEmail: actor.email,
        filename,
        createdAt: new Date().toISOString(),
      });
    }
    return;
  }
  await withTenant(actor, (client) =>
    client.query(
      `INSERT INTO uploads (id, filename, company_id, owner_email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, filename, actor.companyId, actor.email]
    )
  );
}

/** True iff the upload was recorded as belonging to the actor's company. */
export async function uploadBelongsToActorCompany(
  actor: Pick<Actor, "companyId">,
  id: string
): Promise<boolean> {
  const uploadId = String(id || "").trim();
  if (!uploadId) return false;
  if (!useDatabase()) {
    const meta = memoryUploads.get(uploadId);
    return Boolean(meta && meta.companyId === actor.companyId);
  }
  // The company predicate is written out explicitly, and RLS (migration 023) is
  // the second layer rather than the only one.
  //
  // This query used to be `WHERE id = $1` alone, relying entirely on the RLS
  // policy to scope the row to the caller's company. The problem with that is
  // not that RLS is weak. It is that RLS is a property of the DATABASE ROLE,
  // not of this code: it is bypassed outright for a superuser or any role with
  // BYPASSRLS, and FORCE removes only the table owner's ordinary exemption. On
  // such a connection this function returns true for ANOTHER tenant's upload
  // id, and routes/uploads.ts then both streams that file and mints a signed
  // URL for it — reproduced against a Postgres whose role has BYPASSRLS, which
  // is what CI's own postgres:16 user is, and what H1's notes record Neon's
  // owner role as.
  //
  // THE RULE: tenant isolation must not depend on a database role attribute.
  // A role attribute can change with no code change, no failing test and no log
  // line — a managed-database migration, a restore run as a different user, a
  // provider that hands the application an owner-level role. Isolation resting
  // on one is isolation nobody reviews. So this check asserts ownership itself,
  // and RLS stays behind it.
  //
  // Whether a particular deployment's role bypasses RLS *today* is deliberately
  // NOT recorded here. That is a dated fact about infrastructure, and a comment
  // next to security code that quietly goes stale is worse than no comment at
  // all. docs/AUDIT.md H9 carries the dated verification.
  //
  // Every other tenant-scoped read in this codebase already carries its own
  // `WHERE company_id = ...`; this was the one place where RLS was the sole
  // mechanism.
  const result = await withTenant(actor, (client) =>
    client.query(`SELECT 1 FROM uploads WHERE id = $1 AND company_id = $2 LIMIT 1`, [
      uploadId,
      actor.companyId,
    ])
  );
  return (result.rowCount ?? 0) > 0;
}

export function resetUploadsStoreForTests() {
  memoryUploads.clear();
}
