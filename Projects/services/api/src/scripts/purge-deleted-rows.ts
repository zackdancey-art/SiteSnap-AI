/**
 * The purge. BUILT, NOT RUN — and it has never been run against anything.
 *
 * WHAT IT IS FOR
 *
 * The bin keeps a soft-deleted site and everything under it for
 * BIN_RETENTION_DAYS. Something eventually has to remove the rows, or the
 * retention promise is a promise to keep records forever. This is that
 * something, and it is a hand-run script on purpose.
 *
 * WHAT IT IS NOT
 *
 * It is not imported by the server. It is not wired to boot. There is no
 * scheduler, no cron entry, no Render job and no npm script that invokes it —
 * `purge-script-is-unreachable.test.ts` asserts all of that and fails the build
 * if any of it changes. The only way it runs is a person typing its name.
 *
 * THIS IS THE ONE IRREVERSIBLE THING IN THE PHASE, SO READ THE GATES
 *
 * Deleting a `project_sites` row cascades to NINE tables — project_entries,
 * project_diaries, project_templates, site_members, site_invites,
 * crew_timecards, incidents, inspections, material_deliveries. That cascade is
 * the whole reason the bin exists; at purge time it is the intended effect, and
 * there is no undo. This is a seven-year compliance product, so the script is
 * built to be hard to fire by accident:
 *
 *   1. It never reads DATABASE_URL. It reads PURGE_DATABASE_URL and nothing
 *      else, so running it on a machine configured for an environment does not
 *      point it at that environment's database. Absent: it refuses.
 *   2. If PURGE_DATABASE_URL equals DATABASE_URL it refuses. Pointing it at
 *      whatever the API on this host is using has to be impossible, because
 *      that is precisely the mistake with no recovery.
 *   3. It refuses unless PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS=yes.
 *   4. It is a DRY RUN unless `--execute` is passed. The dry run opens no
 *      transaction and issues no DELETE; it counts and prints.
 *   5. `--execute` additionally requires `--expect=<n>`, and n must equal the
 *      number of eligible rows the script measures for itself at that moment.
 *      So the operator has to have run the dry run, read its number, and pass
 *      it back — and if anything changed in between, the run refuses rather
 *      than deleting a different set than the one that was reviewed.
 *
 * Every gate fails CLOSED and says which one refused.
 *
 * WHY IT RUNS PER COMPANY, WHICH IS NOT AN OPTIMISATION
 *
 * All five soft-deletable tables are FORCE ROW LEVEL SECURITY (migrations 019,
 * 022 and 025) with a policy of
 * `company_id = current_setting('app.company_id', true)`. FORCE subjects the
 * table owner too, and the API connects as the owner. So a statement issued on a
 * bare pool with no tenant set compares `company_id` against NULL and matches
 * ZERO ROWS — silently, with no error.
 *
 * The first version of this script did exactly that. It would have counted zero
 * eligible rows for ever, printed "Nothing is eligible", and exited 0: a purge
 * that reports success and has never been capable of deleting anything. That is
 * AUDIT L99 again — a predicate that silently matches nothing — except that here
 * the failure hides in the one script whose whole job is to act on the count.
 * Migration 025 names the same trap in its own comments, about its own backfill.
 *
 * So the script enumerates companies (the `companies` table is the tenant root
 * and carries no RLS) and does its work with `app.company_id` set per company,
 * the same `set_config(..., is_local => true)` that storage/tenant.ts uses. It
 * does not use withTenant() itself, because that reads DATABASE_URL through
 * getPgPool() and gate 1 forbids this script from ever touching DATABASE_URL.
 *
 * A row whose `company_id` is NULL — orphaned, which migration 025 leaves
 * possible on purpose — is invisible to every company's pass and is therefore
 * NEVER purged. That fails safe, and it is REPORTED rather than repaired: this
 * is a compliance product and deciding what happens to an orphaned record is the
 * owner's call, not this script's.
 *
 * WHY THE TABLE ORDER IS DECLARED AND NOT INHERITED
 *
 * Deleting a `project_sites` row cascades to the four child tables that are
 * themselves soft-deletable. If the parent went first, the cascade would destroy
 * child rows that a later statement had been counted on to match, `deleted`
 * would come up short of `measured`, and the run would roll back — or, with the
 * comparison written differently, would delete more than was approved. Children
 * before parents is load-bearing. SOFT_DELETABLE_TABLES is alphabetical and
 * happens to satisfy it today, which is not a reason to rely on it: PURGE_ORDER
 * below states it, and is asserted to be a permutation of the registry so that
 * adding a sixth table without placing it fails loudly.
 *
 * NO HAND-WRITTEN PREDICATES
 *
 * Table names come from SOFT_DELETABLE_TABLES and the eligibility predicate
 * from purgeEligible(), both in storage/softDelete.ts. AUDIT L99 was a
 * `deleted_at` predicate typed out against a table that had no such column; a
 * purge script is the last place to repeat that, because there the statement
 * that silently matches the wrong rows is a statement that destroys them.
 */

import { Pool, PoolClient } from "pg";
import {
  BIN_RETENTION_DAYS,
  SOFT_DELETABLE_TABLES,
  type SoftDeletableTable,
  purgeEligible,
} from "../storage/softDelete";

/**
 * The order the DELETEs are issued in: children before parents.
 *
 * `project_sites` is last because deleting it cascades to the four tables above
 * it. See the header. The assertion below is what makes this a declaration
 * rather than a comment — a table added to SOFT_DELETABLE_TABLES and not placed
 * here throws at module load, before any connection is opened.
 */
export const PURGE_ORDER = [
  "crew_timecards",
  "incidents",
  "inspections",
  "material_deliveries",
  "project_sites",
] as const satisfies readonly SoftDeletableTable[];

/**
 * Throws unless PURGE_ORDER is exactly SOFT_DELETABLE_TABLES, reordered.
 *
 * Exported and called at module load both. A purge that silently skipped a
 * table would leave rows past their retention period for ever, and a purge that
 * named a table twice would double-count against `--expect` and roll back every
 * run; neither announces itself.
 */
export function assertPurgeOrderCoversRegistry(
  order: readonly string[] = PURGE_ORDER,
  registry: readonly string[] = SOFT_DELETABLE_TABLES
): void {
  const seen = new Set(order);
  if (seen.size !== order.length) {
    throw new Error(`PURGE_ORDER names a table twice: ${order.join(", ")}`);
  }
  const missing = registry.filter((t) => !seen.has(t));
  const extra = order.filter((t) => !registry.includes(t));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `PURGE_ORDER does not match SOFT_DELETABLE_TABLES. ` +
        `Missing from the order: ${missing.join(", ") || "(none)"}. ` +
        `Not in the registry: ${extra.join(", ") || "(none)"}. ` +
        `Adding a soft-deletable table means placing it in PURGE_ORDER too, ` +
        `children before parents.`
    );
  }
  if (order[order.length - 1] !== "project_sites") {
    throw new Error(
      `PURGE_ORDER must end with project_sites: deleting a site cascades to the ` +
        `other four tables, so it has to go last.`
    );
  }
}

assertPurgeOrderCoversRegistry();

/** Why a run refused, in the words printed to the operator. */
export type Refusal = { ok: false; reason: string };
export type Plan = {
  ok: true;
  databaseUrl: string;
  execute: boolean;
  expect: number | null;
};

/**
 * The gates, as a pure function of argv and env so they can be tested without
 * a database. Every branch returns a reason; none of them throws, because a
 * stack trace is a worse answer than a sentence when the question is "why did
 * this refuse to delete anything".
 */
export function planRun(argv: readonly string[], env: Record<string, string | undefined>): Plan | Refusal {
  const target = env.PURGE_DATABASE_URL;
  if (!target) {
    return {
      ok: false,
      reason:
        "PURGE_DATABASE_URL is not set. This script never reads DATABASE_URL — the " +
        "database to purge must be named explicitly, so that running it on a host " +
        "configured for an environment cannot point it at that environment.",
    };
  }
  if (env.DATABASE_URL && env.DATABASE_URL === target) {
    return {
      ok: false,
      reason:
        "PURGE_DATABASE_URL is the same as DATABASE_URL — the database this host's API " +
        "is configured to use. Refusing. If that really is the intended target, run this " +
        "from somewhere DATABASE_URL is not set.",
    };
  }
  if (env.PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS !== "yes") {
    return {
      ok: false,
      reason:
        "PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS is not \"yes\". Deleting a site row " +
        "cascades to nine tables of compliance records and cannot be undone.",
    };
  }

  const execute = argv.includes("--execute");
  const expectArg = argv.find((a) => a.startsWith("--expect="));
  const expect = expectArg === undefined ? null : Number(expectArg.slice("--expect=".length));

  if (!execute) {
    if (expect !== null) {
      return { ok: false, reason: "--expect was passed without --execute. A dry run counts; it does not need a number." };
    }
    return { ok: true, databaseUrl: target, execute: false, expect: null };
  }
  if (expect === null) {
    return {
      ok: false,
      reason:
        "--execute requires --expect=<n>, where n is the eligible-row total this script " +
        "printed on the dry run. Run it without --execute first and pass that number back.",
    };
  }
  if (!Number.isInteger(expect) || expect < 0) {
    return { ok: false, reason: `--expect must be a non-negative whole number, got ${JSON.stringify(expectArg)}.` };
  }
  return { ok: true, databaseUrl: target, execute: true, expect };
}

/** One row per soft-deletable table: how many rows are past the retention period. */
export type EligibleCount = { table: SoftDeletableTable; eligible: number };

/**
 * `SET LOCAL app.company_id` for the rest of the caller's transaction.
 *
 * Same call as storage/tenant.ts line 35, deliberately duplicated rather than
 * imported: withTenant() obtains its connection from getPgPool(), which reads
 * DATABASE_URL, and gate 1 is that this script never reads DATABASE_URL. The
 * duplication is four tokens; the alternative is a destructive script with a
 * path to the wrong database.
 */
async function setTenant(client: PoolClient, companyId: string): Promise<void> {
  await client.query("SELECT set_config('app.company_id', $1, true)", [companyId]);
}

/**
 * Every company id, from the tenant root.
 *
 * `companies` carries no RLS (migration 014 creates it as the tenant root and no
 * later migration enables it), so this is the one read here that works on a bare
 * connection. Companies are never hard-deleted — 014 states it and the `status`
 * column soft-cancels instead — so enumerating them is complete, including
 * cancelled ones, whose rows still age out of the bin like anyone else's.
 */
export async function listCompanyIds(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM companies ORDER BY id`);
  return r.rows.map((row) => row.id);
}

/**
 * Eligible rows per table, summed over every company.
 *
 * Counted inside ONE transaction with the tenant reset per company, because
 * `set_config(..., is_local => true)` is transaction-scoped: on a bare
 * `pool.query` the setting would be gone by the next statement and every count
 * would be zero. A read-only transaction, so it opens nothing that could write.
 *
 * WHAT THIS CANNOT SEE, stated because a silent gap is the failure mode of the
 * whole file: a row whose `company_id` is NULL, or is some value not present in
 * `companies`, matches no company's policy and is invisible here. It is
 * therefore never counted and never purged. The script does NOT lift FORCE to go
 * looking — an orphaned compliance record is the owner's decision, and a
 * destructive script is the worst possible place to put the power to disable
 * tenant isolation.
 */
export async function countEligible(pool: Pool, companyIds: readonly string[]): Promise<EligibleCount[]> {
  const totals = new Map<SoftDeletableTable, number>(SOFT_DELETABLE_TABLES.map((t) => [t, 0]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    for (const companyId of companyIds) {
      await setTenant(client, companyId);
      for (const table of PURGE_ORDER) {
        // Table name from the registry's own frozen tuple, predicate from the
        // registry's own builder. Neither is interpolated from input.
        const r = await client.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${purgeEligible(table)}`
        );
        totals.set(table, (totals.get(table) ?? 0) + Number(r.rows[0].n));
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return PURGE_ORDER.map((table) => ({ table, eligible: totals.get(table) ?? 0 }));
}

export function totalEligible(counts: readonly EligibleCount[]): number {
  return counts.reduce((sum, c) => sum + c.eligible, 0);
}

export function formatPlan(counts: readonly EligibleCount[]): string {
  const width = Math.max(...counts.map((c) => c.table.length));
  const lines = counts.map((c) => `  ${c.table.padEnd(width)}  ${c.eligible}`);
  return (
    `Rows in the bin for more than ${BIN_RETENTION_DAYS} days:\n` +
    lines.join("\n") +
    `\n  ${"total".padEnd(width)}  ${totalEligible(counts)}`
  );
}

/**
 * Issues the DELETEs, inside a transaction the CALLER has already opened.
 *
 * Separated from main() so the statement sequence can be asserted without a
 * database: the only verification available in this environment is a unit test,
 * and what has to be verified is an ORDER — the tenant set before every DELETE,
 * children before parents. A fake client that records its queries proves both.
 * `purge-script-is-unreachable.test.ts` does exactly that.
 *
 * It does not BEGIN, COMMIT or ROLLBACK. The caller owns the transaction,
 * because the decision to commit depends on comparing this return value against
 * the operator's approved number, and a function that both deletes and commits
 * could not be driven by a test without a real database to roll back.
 *
 * `set_config(..., is_local => true)` is transaction-scoped, so resetting the
 * tenant per company inside one transaction still gives all-or-nothing across
 * every company while each statement runs with the right tenant set.
 *
 * Returns the number of DIRECTLY matched rows. Rows removed by `ON DELETE
 * CASCADE` from a purged `project_sites` are not counted — `rowCount` reports
 * only a statement's own matches — which is what keeps the total comparable with
 * the one countEligible() measured.
 */
export async function deleteEligible(
  client: PoolClient,
  companyIds: readonly string[]
): Promise<number> {
  let deleted = 0;
  for (const companyId of companyIds) {
    await setTenant(client, companyId);
    for (const table of PURGE_ORDER) {
      const r = await client.query(`DELETE FROM ${table} WHERE ${purgeEligible(table)}`);
      deleted += r.rowCount ?? 0;
    }
  }
  return deleted;
}

async function main(): Promise<number> {
  const plan = planRun(process.argv.slice(2), process.env);
  if (!plan.ok) {
    console.error(`purge-deleted-rows: REFUSED.\n${plan.reason}`);
    return 2;
  }

  const pool = new Pool({ connectionString: plan.databaseUrl });
  try {
    const companyIds = await listCompanyIds(pool);
    if (companyIds.length === 0) {
      // Not "nothing to purge". Every table here is RLS-forced, so with no
      // company to scope by there is nothing this script can even SEE, and
      // reporting a zero would be reporting a measurement it never took.
      console.error(
        "purge-deleted-rows: REFUSED.\n" +
          "The `companies` table is empty, so there is no tenant to scope by and " +
          "every count would read zero whatever the bin holds. Check PURGE_DATABASE_URL " +
          "points at the database you meant."
      );
      return 2;
    }
    console.log(`Scoped to ${companyIds.length} company/companies.`);

    const counts = await countEligible(pool, companyIds);
    console.log(formatPlan(counts));

    if (!plan.execute) {
      console.log(
        "\nDRY RUN — nothing was deleted and no transaction was opened.\n" +
          "To delete exactly these rows: --execute --expect=" +
          totalEligible(counts)
      );
      return 0;
    }

    const measured = totalEligible(counts);
    if (measured !== plan.expect) {
      console.error(
        `\npurge-deleted-rows: REFUSED.\n` +
          `--expect=${plan.expect} but ${measured} rows are eligible right now. The set has ` +
          `changed since the dry run, so this run would delete a different set than the one ` +
          `that was reviewed. Re-run the dry run.`
      );
      return 2;
    }
    if (measured === 0) {
      console.log("\nNothing is eligible. No statement was issued.");
      return 0;
    }

    // One transaction for the whole purge. A partial purge would leave the bin
    // in a state no listing describes, and the operator reading the printed
    // total has been told it is all-or-nothing.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await deleteEligible(client, companyIds);
      if (deleted !== measured) {
        // Counted and deleted inside different statements, so the two can
        // differ if anything wrote in between. Roll back rather than report a
        // number that was not what was approved.
        await client.query("ROLLBACK");
        console.error(
          `\npurge-deleted-rows: ROLLED BACK.\n` +
            `${deleted} rows matched the DELETE but ${measured} were approved. Nothing was deleted.`
        );
        return 2;
      }
      await client.query("COMMIT");
      console.log(`\nPurged ${deleted} row(s). This cannot be undone.`);
      return 0;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// `require.main === module` rather than a bare call: importing this file must
// not run it. The structural guarantee is the unreachability test, and this is
// the belt to its braces.
if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
