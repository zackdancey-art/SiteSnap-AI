import { Pool, PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import { CLIENTS_TABLE, SITE_CLIENT_COLUMN } from "../storage/clientsStore";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BACKFILL: TURN project_sites.client FREE TEXT INTO clients ROWS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Migration 032 adds the `clients` table and a nullable
 * `project_sites.client_id`, and deliberately backfills nothing. Every existing
 * site keeps its free-text `client` and shows as "Unfiled", which is a correct
 * and working state — the product does not require this script to have run.
 *
 * This is the opt-in convenience: a company with forty sites carrying twelve
 * distinct client labels gets twelve clients and forty filed sites, instead of
 * retyping them. It is NOT part of the migration sequence and is never run at
 * boot, because deciding that "Metro Builders" and "Metro Builders Pty Ltd" are
 * one client or two is a judgement about somebody's business that only they can
 * make. So this script makes the conservative choice — same normalised string,
 * same client; anything else, different clients — and PRINTS THE NEAR-DUPLICATES
 * it refused to merge, for a person to look at.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  THE FOUR SAFETY PROPERTIES, AND HOW EACH IS STRUCTURAL RATHER THAN CAREFUL
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 1. IT CANNOT REACH THE PRODUCTION DATABASE BY DEFAULT. It builds its own
 *    Pool from BACKFILL_DATABASE_URL and never calls getPgPool(). An unset
 *    BACKFILL_DATABASE_URL is a refusal, not a fallback.
 *
 *    Measured rather than asserted — against the COMPILED output, because that
 *    is what runs:
 *      $ grep -o 'process\.env\.[A-Z_]*' dist/scripts/backfill-clients.js | sort -u
 *      process.env.BACKFILL_DATABASE_URL
 *      process.env.PG_SSL
 *      process.env.PG_SSL_REJECT_UNAUTHORIZED
 *    and with DATABASE_URL deliberately set to a bogus value and
 *    BACKFILL_DATABASE_URL unset, it still refuses and exits 1.
 *
 *    The precise claim, since this file does import from clientsStore: it takes
 *    two string constants from there and calls nothing, so `useDatabase()` —
 *    which does read DATABASE_URL — is never invoked and no pool is ever built
 *    from it. The grep above covers this file; that sentence covers the import.
 *
 * 2. DRY RUN IS THE DEFAULT, AND THE DRY RUN IS NOT A PREDICTION. It performs
 *    every insert and update for real inside a transaction and then ROLLS BACK.
 *    So the numbers it reports are measured against the actual unique index and
 *    the actual foreign key — including the conflicts — rather than being a
 *    guess about what would happen. `--apply` changes exactly one thing: COMMIT
 *    instead of ROLLBACK.
 *
 * 3. IT WRITES NOTHING THAT EXISTS. It inserts clients with ON CONFLICT DO
 *    NOTHING against 032's unique index, and it updates only sites whose
 *    client_id IS NULL. A site already filed is never re-filed, a client
 *    already present is never duplicated, and no row's existing value is
 *    overwritten — including `client`, the free-text label, which this script
 *    reads and never writes. Reversing a run is `UPDATE project_sites SET
 *    client_id = NULL` plus deleting the clients it created.
 *
 * 4. IT DOES NOT TOUCH ROW-LEVEL SECURITY. It enumerates companies from
 *    auth_users, which has no RLS, and then does all tenanted work inside
 *    `SET LOCAL app.company_id` per company — the same mechanism as
 *    storage/tenant.ts, written out here because withTenant() goes through
 *    getPgPool() and property 1 forbids that. It never lifts FORCE, which the
 *    H7 backfill migration had to do and which would leave RLS unforced on a
 *    table if this script died mid-run.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  USAGE
 * ───────────────────────────────────────────────────────────────────────────
 *
 *   BACKFILL_DATABASE_URL=postgres://... node dist/scripts/backfill-clients.js
 *   BACKFILL_DATABASE_URL=postgres://... node dist/scripts/backfill-clients.js --apply
 *
 * Read the dry run before using --apply. It names every client it would create
 * and every near-duplicate pair it would leave alone.
 */

/** Set `client_id` on sites whose label matches, never on a site already filed. */
const SITES_TABLE = "project_sites";
/** The free-text column this reads and never writes. */
const SITE_LABEL_COLUMN = "client";

type Plan = {
  companyId: string;
  createdBy: string;
  /** Normalised label → the spelling that will become the client's name. */
  labels: Map<string, { name: string; siteIds: string[]; spellings: Set<string> }>;
};

/** The fold migration 032's unique index uses: `lower(btrim(name))`. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Pairs of labels this script deliberately did NOT merge, for a person to read.
 *
 * The test is crude on purpose — one is a prefix of the other, or they differ
 * only by punctuation — because its output is advice and not an action. A
 * cleverer similarity score would invite somebody to wire it up to an automatic
 * merge, which is the one thing this script must not do.
 */
function nearDuplicates(keys: string[]): [string, string][] {
  const strip = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const pairs: [string, string][] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = strip(keys[i]);
      const b = strip(keys[j]);
      if (!a || !b) continue;
      if (a === b || a.startsWith(b) || b.startsWith(a)) pairs.push([keys[i], keys[j]]);
    }
  }
  return pairs;
}

async function withCompany<T>(
  client: PoolClient,
  companyId: string,
  fn: () => Promise<T>
): Promise<T> {
  // is_local = true → SET LOCAL semantics, scoped to the open transaction.
  // Identical to storage/tenant.ts; see property 4 above for why it is not
  // simply imported.
  await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
  return fn();
}

async function buildPlans(client: PoolClient): Promise<{ plans: Plan[]; skipped: string[] }> {
  // auth_users carries no RLS policy, so this enumeration needs no tenant
  // context and no FORCE lifting. The owner is taken as `created_by` because
  // that column is provenance only — nothing reads it to make a decision (see
  // the note in storage/clientsStore.ts) — and an owner is the one role
  // guaranteed to exist for a company that has sites.
  const companies = await client.query<{ company_id: string; email: string | null }>(
    `SELECT u.company_id,
            MIN(u.email) FILTER (WHERE u.company_role = 'owner') AS email
       FROM auth_users u
      WHERE u.company_id IS NOT NULL
      GROUP BY u.company_id
      ORDER BY u.company_id`
  );

  const plans: Plan[] = [];
  const skipped: string[] = [];

  for (const row of companies.rows) {
    if (!row.email) {
      // No owner means no legal value for clients.created_by, which is NOT NULL
      // and references auth_users(email). Skip and say so rather than invent a
      // creator or relax the column.
      skipped.push(`${row.company_id} (no owner account, so clients.created_by has no value)`);
      continue;
    }

    const plan: Plan = { companyId: row.company_id, createdBy: row.email, labels: new Map() };

    await withCompany(client, row.company_id, async () => {
      const sites = await client.query<{ id: string; label: string | null }>(
        `SELECT id, ${SITE_LABEL_COLUMN} AS label
           FROM ${SITES_TABLE}
          WHERE ${SITE_CLIENT_COLUMN} IS NULL
          ORDER BY created_at`
      );
      for (const site of sites.rows) {
        const label = (site.label ?? "").trim();
        // An empty label is a site with nothing to file it under. It stays
        // unfiled, which is a first-class state, not a problem to solve.
        if (!label) continue;
        const key = nameKey(label);
        const existing = plan.labels.get(key);
        if (existing) {
          existing.siteIds.push(site.id);
          existing.spellings.add(label);
        } else {
          plan.labels.set(key, { name: label, siteIds: [site.id], spellings: new Set([label]) });
        }
      }
    });

    if (plan.labels.size > 0) plans.push(plan);
  }

  return { plans, skipped };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const url = process.env.BACKFILL_DATABASE_URL;

  if (!url || !url.trim()) {
    console.error("BACKFILL_DATABASE_URL is not set.");
    console.error("");
    console.error("This script deliberately does not read DATABASE_URL — there is no");
    console.error("code path here that can reach the production database without being");
    console.error("told to. Set BACKFILL_DATABASE_URL to the database you mean.");
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({
    connectionString: url,
    ssl:
      process.env.PG_SSL === "require"
        ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false" }
        : undefined,
  });

  const client = await pool.connect();
  let createdClients = 0;
  let filedSites = 0;
  let conflictedClients = 0;

  try {
    await client.query("BEGIN");

    const { plans, skipped } = await buildPlans(client);

    console.log(apply ? "APPLYING." : "DRY RUN. Nothing will be committed.");
    console.log("");

    for (const plan of plans) {
      console.log(`company ${plan.companyId} — creator ${plan.createdBy}`);
      await withCompany(client, plan.companyId, async () => {
        for (const [key, entry] of plan.labels) {
          const id = uuidv4();
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO ${CLIENTS_TABLE} (id, company_id, name, created_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (company_id, lower(btrim(name))) DO NOTHING
             RETURNING id`,
            [id, plan.companyId, entry.name, plan.createdBy]
          );

          let clientId: string;
          if (inserted.rows.length > 0) {
            clientId = inserted.rows[0].id;
            createdClients++;
          } else {
            // The client already exists — somebody created it through the
            // product before running this. Its sites still want filing, so
            // find it rather than skipping them.
            conflictedClients++;
            const found = await client.query<{ id: string }>(
              `SELECT id FROM ${CLIENTS_TABLE}
                WHERE company_id = $1 AND lower(btrim(name)) = $2`,
              [plan.companyId, key]
            );
            if (found.rows.length === 0) {
              // ON CONFLICT fired but the row is not visible. That means the
              // tenant context is wrong, not that the data is odd — fail
              // rather than carry on writing under a company we cannot read.
              throw new Error(
                `client "${entry.name}" conflicted in company ${plan.companyId} but is not readable; ` +
                  "the tenant context is wrong. No changes have been committed."
              );
            }
            clientId = found.rows[0].id;
          }

          const updated = await client.query(
            `UPDATE ${SITES_TABLE}
                SET ${SITE_CLIENT_COLUMN} = $1
              WHERE id = ANY($2::text[])
                AND ${SITE_CLIENT_COLUMN} IS NULL`,
            [clientId, entry.siteIds]
          );
          filedSites += updated.rowCount ?? 0;

          const spellings = [...entry.spellings];
          const note = spellings.length > 1 ? `  [${spellings.length} spellings: ${spellings.join(" | ")}]` : "";
          console.log(`  ${entry.name} → ${updated.rowCount ?? 0} site(s)${note}`);
        }

        const pairs = nearDuplicates([...plan.labels.keys()]);
        for (const [a, b] of pairs) {
          console.log(`  NOT MERGED, look at these: "${a}" and "${b}" — one client or two is your call.`);
        }
      });
      console.log("");
    }

    if (skipped.length > 0) {
      console.log("Skipped companies:");
      for (const s of skipped) console.log(`  ${s}`);
      console.log("");
    }

    // Measured from what the database actually did, not from the plan.
    console.log(`clients created:   ${createdClients}`);
    console.log(`clients already there: ${conflictedClients}`);
    console.log(`sites filed:       ${filedSites}`);
    console.log("");

    if (apply) {
      await client.query("COMMIT");
      console.log("COMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("ROLLED BACK — this was a dry run. Re-run with --apply to keep it.");
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* surface the original error */
    }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
