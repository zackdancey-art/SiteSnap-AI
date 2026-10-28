/**
 * What a crew member may and may not do, measured against real Postgres.
 *
 * WHY THIS FILE IS THE AUTHORITATIVE ONE
 *
 * AUDIT L66 measured a crew member 403'd on 9 of 9 reachable GETs while the
 * owner got 200 on the same 9 — the entire field product refused to the person
 * who does the field work, by one pathless `requireAtLeast("viewer")`. AUDIT
 * L65 is why that measurement cannot be trusted to the in-memory suite: the
 * in-memory store and the Postgres store are two implementations, and the
 * suite can be green while production is broken.
 *
 * So this is the table, against the database that production uses, with all
 * six rows in the same test file against the same routes:
 *
 *   - crew 2xx on every operational route, read AND write
 *   - crew 403 on invitation, site deletion, company settings and the
 *     supervisor dashboard
 *   - crew 2xx AND 403 on the diary routes, depending on whether the body
 *     carries `status` — the one requirement here that is finer than a route
 *   - crew and the owner receive THE SAME ROWS, compared by id, on every
 *     shared record type
 *   - crew 2xx editing a row they wrote and 403 editing one they did not,
 *     with the owner 2xx on both
 *   - owner 2xx on all of them
 *
 * The third row is the one to read carefully. Approving a diary is manager+
 * (AUDIT L81) while editing one is not, so the gate is on a FIELD, and the only
 * thing that distinguishes a correct field gate from a route-level gate — which
 * would have taken diaries away from the people who write them — is that the
 * same route answers both ways for the same role. Those two probes are in one
 * test for that reason; neither is evidence without the other.
 *
 * WHY ROWS FOUR AND FIVE EXIST: A STATUS CODE MISSED THIS TWICE
 *
 * The first three rows measure status codes, and a status code could not see
 * either defect the corrected decision names. A 200 returning a filtered
 * subset is indistinguishable from a 200 returning everything, so fifteen
 * green GETs proved reachability while crew were in fact seeing only their own
 * entries. And every write the table measured was a crew member writing their
 * OWN row, so nothing in it ever exercised crew touching somebody else's —
 * which is how two stores came to have no authorship check at all on their
 * Postgres path (AUDIT L89).
 *
 * So row four compares what each role RECEIVED, by id, not what the route
 * answered; and row five writes each record type twice, once per author, and
 * crosses them over. Timesheets are the named exception and the one row that
 * must NOT match — pay information, not a shared site record.
 *
 * BOTH CONTROLS, ON THE SAME ROUTE, IN THE SAME TEST — DELIBERATELY
 *
 * A 403 assertion on its own passes equally well when the route has been
 * deleted, and a 200 assertion on its own passes when every gate has been
 * removed. Neither half is evidence by itself. Every probe below therefore
 * carries both roles, and `measure()` records what each one answered so the
 * table printed at the end is the measurement rather than a restatement of
 * what the test expected.
 *
 * The same rule applies to the id comparisons, in both directions: two empty
 * lists are trivially "the same rows", so the owner control asserts it saw
 * something first; and for timesheets, where the lists must differ, the
 * control is that the owner CAN see the crew member's — otherwise a route
 * returning nothing to anybody would pass.
 *
 * WHY THE CREW TOKEN IS NOT JUST A REGISTERED USER
 *
 * `registerUser` creates a company and makes the registrant its OWNER; a test
 * that then rewrites the role in the store is not the journey a real invitee
 * takes. Here the crew member is invited to a site at role "crew", registers,
 * and accepts — which is how a crew member actually comes to exist — and the
 * token the table is measured with is the fresh one the accept route issues.
 * `verifyAuthToken` is then asked, directly, whether that token really carries
 * companyRole "crew", because `requireAtLeast` reads the TOKEN and `/auth/me`
 * reads the store, so the two can disagree and only one of them gates a route.
 * Without that assertion the whole table could be measuring a viewer.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "crew-permissions-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { deleteUserAccount } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { verifyAuthToken } from "../utils/authToken";
import { applyMigrations } from "../storage/testMigrations";

if (!process.env.TEST_DATABASE_URL) {
  test("crew permissions table (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // See the sibling note in invite-accept-identity-db.test.ts: every store here
  // branches on DATABASE_URL and test-setup.ts blanks it, so without this line
  // the table would measure the in-memory implementation — the one it is not
  // about. It cannot reach production: getPgPool() refuses DATABASE_URL when
  // NODE_ENV === "test", and node:test gives each file its own process.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;


  const runId = Date.now().toString().slice(-7);
  const OWNER = `crew-perm-owner-${runId}@example.test`;
  const CREW = `crew-perm-crew-${runId}@example.test`;
  const PASSWORD = "Password123!";
  const TODAY = "2026-10-11";

  /**
   * The population of each half of the table, pinned.
   *
   * A route quietly dropped from a list below would otherwise take its row out
   * of the measurement and still leave the file green — the same failure mode
   * as a suite that passes because its selector matched nothing. Changing a
   * number here is changing what "crew can do their job" means, so it has to
   * happen in the same commit as the route that moved.
   */
  const EXPECTED_READS = 15;
  // 14, not 13. The sequence has contained fourteen steps since 897fc80, the
  // commit that introduced this pin — so the number was wrong at birth rather
  // than made wrong by a later change, and nothing had ever caught it because
  // the sequence had never once run to completion against Postgres. Step 13,
  // `PATCH /projects/sites/:id/progress`, named a column project_sites has not
  // got; the statement errored, the route sent no response at all, and the run
  // died there on a client timeout. So step 14 never executed, this assertion
  // was never reached, and this count had never been taken. AUDIT L99.
  const EXPECTED_WRITE_STEPS = 14;
  // 16, not 15. The sixteenth is voiding an inspection signature (AUDIT L91),
  // which was decided manager+ and then never built: the route carried only
  // FIELD_ACCESS — identity, not rank — on main and on every feature branch, so
  // any crew member with a login could retract any signature in their company.
  // Measured by running this half; see the probe's own comment below.
  const EXPECTED_REFUSALS = 16;
  const EXPECTED_FIELD_PROBES = 4;
  /**
   * The two populations the corrected decision added, and the reason the four
   * above were not enough.
   *
   * EXPECTED_PARITY_KINDS counts the record types whose list route is compared
   * BY ID between the two roles. The four populations above measure status
   * codes, and a 200 returning a filtered subset is indistinguishable from a
   * 200 returning everything — so EXPECTED_READS proved reachability and said
   * nothing about what came back. These rows are the ones that can tell the
   * difference.
   *
   * EXPECTED_OWNERSHIP_PROBES counts the write probes, five per authored
   * record type. The old write sequence had each role create, edit and delete
   * its OWN rows, so nothing in it ever exercised crew touching somebody
   * else's — which is how the write-side gap survived a table that claimed to
   * measure crew writes.
   */
  const EXPECTED_PARITY_KINDS = 5;
  const EXPECTED_OWNERSHIP_PROBES = 20;

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let crewToken: string;
  let companyId: string;
  let siteId: string;
  let phoneSeq = 0;

  type Answer<T> = { status: number; body: T };

  const req = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await fetch(`${baseUrl}/api${p}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: T;
    try { parsed = JSON.parse(text) as T; } catch { parsed = { error: text } as unknown as T; }
    return { status: res.status, body: parsed };
  };

  /** A request whose response is CHECKED — see the note in routes/invites.test.ts. */
  const seed = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await req<T>(method, p, body, token);
    assert.ok(res.status >= 200 && res.status < 300, `seed ${method} ${p} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  const register = async (email: string, fullName: string): Promise<string> => {
    const phone = `+6140${runId.slice(-5)}${(++phoneSeq).toString().padStart(2, "0")}`;
    const reg = await seed<{ devCodes?: { emailCode: string } }>("POST", "/auth/register", { email, password: PASSWORD, phone, fullName });
    const emailCode = reg.body.devCodes?.emailCode;
    assert.ok(emailCode, "registration did not return a dev email code");
    const ve = await seed<{ devCodes?: { smsCode: string } }>("POST", "/auth/register/verify-email", { email, emailCode });
    const smsCode = ve.body.devCodes?.smsCode;
    assert.ok(smsCode, "email verification did not return a dev sms code");
    const done = await seed<{ token: string }>("POST", "/auth/register/verify", { email, smsCode });
    assert.ok(done.body.token, "verification returned no auth token");
    return done.body.token;
  };

  // ── The measurement ────────────────────────────────────────────────────────
  //
  // One row per probe, holding what each role ACTUALLY answered. The table is
  // printed at the end and is the thing quoted in the PR body; the assertions
  // read from the same rows, so the printed table cannot drift from what was
  // asserted.
  type Row = { label: string; route: string; crew: number; owner: number };
  const READS: Row[] = [];
  const WRITES: Row[] = [];
  const REFUSALS: Row[] = [];
  /**
   * The fourth population, and the only one where crew's expected answer
   * differs from row to row: the diary approval gate is on a FIELD, so the same
   * route answers 200 and 403 depending on the body. Kept separate from
   * REFUSALS for that reason — a population where every row must be 403 cannot
   * hold a row that must be 200, and merging them would have meant dropping
   * the blanket claim that makes the other three populations worth having.
   */
  const FIELD: Row[] = [];

  /**
   * The fifth population: what each role actually RECEIVED, not what the route
   * answered. `same` is the measurement — the id sets, sorted and compared.
   */
  type ParityRow = { label: string; route: string; crewIds: number; ownerIds: number; same: boolean };
  const PARITY: ParityRow[] = [];

  /**
   * The sixth: the ownership gate. Like FIELD, crew's expected answer differs
   * from row to row, so the expectation travels with the row rather than being
   * a blanket claim about the population.
   */
  type GateRow = Row & { crewAllowed: boolean };
  const OWNERSHIP: GateRow[] = [];

  const ok = (status: number) => status >= 200 && status < 300;
  const idsOf = (rows: Array<{ id: string }> | undefined) => (rows ?? []).map((r) => r.id).sort();

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);
    resetRateLimitStoreForTests();

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    ownerToken = await register(OWNER, "Crew Perm Owner");
    const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
    companyId = me.body.user.companyId;
    assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

    const site = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Crew Perm Site ${runId}`, address: "1 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
      ownerToken
    );
    siteId = site.body.site.id;

    // The crew member, by the journey a real crew member takes.
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [CREW], role: "crew" }, ownerToken);
    const invites = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const invite = invites.body.invites.find((i) => i.invitedEmail.toLowerCase() === CREW.toLowerCase());
    assert.ok(invite?.token, `no invitation listed for the crew member: ${JSON.stringify(invites.body.invites)}`);

    const registered = await register(CREW, "Crew Member");
    const accepted = await seed<{ token?: string; companyId: string | null }>(
      "POST", "/projects/invites/accept", { token: invite.token }, registered
    );
    assert.equal(accepted.body.companyId, companyId, "the invitation did not attach the crew member to the inviting company");
    crewToken = accepted.body.token ?? registered;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of [OWNER, CREW]) {
      await deleteUserAccount(email).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("precondition: the two tokens really carry the two roles the table claims", () => {
    // requireAtLeast reads the TOKEN, not the store, so this is the only
    // assertion that makes the rest of the file mean anything. /auth/me would
    // answer from the store and could say "crew" while the token said owner.
    const crewClaims = verifyAuthToken(crewToken);
    const ownerClaims = verifyAuthToken(ownerToken);
    assert.ok(crewClaims, "the crew token does not verify");
    assert.ok(ownerClaims, "the owner token does not verify");
    assert.equal(crewClaims.companyRole, "crew", "the crew token does not carry companyRole crew, so no 403 below proves anything about crew");
    assert.equal(ownerClaims.companyRole, "owner", "the owner token does not carry companyRole owner, so no 200 below is an owner control");
    assert.equal(crewClaims.companyId, companyId, "the crew member is not in the company whose rows the table reads");
    assert.equal(ownerClaims.companyId, companyId);
  });

  test("crew read every operational route, and so does the owner", async () => {
    // The field product. L66's nine reachable GETs are all in here, plus the
    // rest of what the mobile app and the portal call on a normal day.
    const reads: Array<[string, string]> = [
      ["bootstrap (every portal screen, and mobile's first load)", "/projects/bootstrap"],
      ["sites", "/projects/sites"],
      ["diary entries", "/projects/entries"],
      ["diaries", "/projects/diaries"],
      ["diary templates", "/projects/templates"],
      ["timesheets", "/crew/timecards"],
      ["incidents", "/incidents"],
      ["inspections", "/inspections"],
      ["inspection templates", "/inspection-templates"],
      ["deliveries", "/deliveries"],
      ["entry templates", "/entry-templates"],
      ["WHS checklists", "/whs-checklists"],
      ["location — live map", "/location/workers"],
      ["push tokens", "/push/tokens"],
      ["account settings (personal, not company)", "/account/settings"],
    ];
    assert.equal(reads.length, EXPECTED_READS, "the operational read population changed — see EXPECTED_READS");

    for (const [label, route] of reads) {
      const asCrew = await req<{ error?: string }>("GET", route, undefined, crewToken);
      const asOwner = await req<{ error?: string }>("GET", route, undefined, ownerToken);
      READS.push({ label, route: `GET ${route}`, crew: asCrew.status, owner: asOwner.status });
      assert.ok(ok(asCrew.status), `crew must be able to read ${route}: ${asCrew.status} ${JSON.stringify(asCrew.body)}`);
      assert.ok(ok(asOwner.status), `the owner control failed on ${route}, so the crew result above proves nothing: ${asOwner.status} ${JSON.stringify(asOwner.body)}`);
    }
  });

  test("crew write the field product, and so does the owner", async () => {
    /**
     * The same sequence run twice, once per role, on the routes a crew member
     * uses to record a day's work. Read access without write access is not the
     * decision — "crew gets, read and write" — and a GET-only table would have
     * passed while every save still failed.
     *
     * Each role creates, edits and deletes its OWN rows, so neither run depends
     * on the other's state and the owner control is a genuine comparison rather
     * than a second pass over the first run's leftovers.
     */
    const sequence = async (who: string, token: string): Promise<Array<[string, string, number]>> => {
      const out: Array<[string, string, number]> = [];
      const step = async <T>(label: string, method: string, p: string, body?: unknown): Promise<Answer<T>> => {
        const res = await req<T>(method, p, body, token);
        out.push([label, `${method} ${p.replace(/\/[0-9a-f-]{8,}/gi, "/:id")}`, res.status]);
        return res;
      };

      const entry = await step<{ entry: { id: string } }>("record a diary entry", "POST", "/projects/entries", {
        siteId, date: TODAY, notes: `${who} was on site`, weather: "Fine", crewCount: "3",
      });
      const entryId = entry.body.entry?.id;
      await step("edit that entry", "PATCH", `/projects/entries/${entryId ?? "missing"}`, { notes: `${who} corrected the note` });

      const diary = await step<{ diary: { id: string } }>("save a diary", "POST", "/projects/diaries", {
        siteId, status: "draft", summary: `${who} daily diary`, reportPeriod: "daily",
      });
      const diaryId = diary.body.diary?.id;
      // Editing a diary, which crew keep in full. Approving one is manager+ as
      // of AUDIT L81 and has moved out of this sequence into its own test —
      // see "the diary gate is on the status field" below. This step stays, in
      // this list, because it is the half that stops that gate from becoming
      // "diary editing is manager-only": if the gate were written at the route
      // instead of the field, this is the row that would go red.
      await step("edit that diary", "PATCH", `/projects/diaries/${diaryId ?? "missing"}`, {
        summary: `${who} corrected the diary`,
      });

      await step("save a diary template", "POST", "/projects/templates", {
        siteId, name: `${who} template`, weather: "Fine", crewCount: "3", notesTemplate: "",
      });
      await step("enter a timesheet", "POST", "/crew/timecards", {
        siteId, workerName: who, date: TODAY, startTime: "07:00", endTime: "15:30", breakMinutes: 30, hoursRegular: 8,
      });
      await step("report an incident", "POST", "/incidents", {
        siteId, date: TODAY, severity: "near-miss", description: `${who} reported a near miss`,
      });
      const tpl = await step<{ template: { id: string } }>("create an inspection template", "POST", "/inspection-templates", {
        name: `${who} checklist`, items: ["Edge protection", "Harness"],
      });
      await step("complete an inspection", "POST", "/inspections", {
        siteId, templateId: tpl.body.template?.id ?? null, name: `${who} inspection`, date: TODAY,
        results: [{ item: "Edge protection", passed: true, notes: "", na: false, photos: [] }], status: "complete",
      });
      await step("log a delivery", "POST", "/deliveries", {
        siteId, date: TODAY, supplier: "Placemakers", items: ["Timber"], quantity: "20", notes: "",
      });
      await step("save an entry template", "POST", "/entry-templates", {
        name: `${who} entry template`, notes: "", crewCount: "3", weather: "Fine",
      });
      await step("send a location ping", "POST", "/location/update", {
        latitude: -36.8485, longitude: 174.7633, accuracy: 5, siteId, userName: who,
      });
      const progressed = await step<{ site: { progressPercent?: number } }>(
        "update site progress", "PATCH", `/projects/sites/${siteId}/progress`, { progressPercent: 42 }
      );
      // Not just the status code. This route answered 200 while returning a
      // site with no progressPercent at all: mapSite never read the
      // `progress_percent` column, so the Postgres path wrote the value and
      // never gave it back, and the mobile slider reset to zero on every
      // reload. A status-code assertion cannot see that — the step above
      // passed throughout. AUDIT L99 fixed the statement; this is the half of
      // the same defect that survived it.
      assert.equal(
        progressed.body.site?.progressPercent, 42,
        "PATCH /progress answered 200 but did not return the progress it stored"
      );
      // Last, because it removes the row the first two steps created.
      await step("delete that entry", "DELETE", `/projects/entries/${entryId ?? "missing"}`);
      return out;
    };

    const asCrew = await sequence("crew", crewToken);
    const asOwner = await sequence("owner", ownerToken);

    // Record what ran BEFORE asserting anything about it. The count assertion
    // below used to come first, and when it threw it left WRITES empty — so the
    // completeness test reported "the write half did not run" for a sequence
    // that had just executed fourteen steps, visible in the request log. A
    // population that changed and a sequence that genuinely never executed are
    // two different problems with two different fixes, and they must not arrive
    // as the same message.
    for (let i = 0; i < asCrew.length; i++) {
      const [label, route, crew] = asCrew[i];
      // -1 where the owner run is shorter; the length assertion below is what
      // reports that, rather than this loop throwing on an index.
      WRITES.push({ label, route, crew, owner: asOwner[i]?.[2] ?? -1 });
    }

    assert.equal(asCrew.length, EXPECTED_WRITE_STEPS, "the operational write population changed — see EXPECTED_WRITE_STEPS");
    assert.equal(asOwner.length, asCrew.length, "the two runs did not perform the same sequence, so they are not comparable");

    for (let i = 0; i < asCrew.length; i++) {
      const [label, route, crewStatus] = asCrew[i];
      const [ownerLabel, , ownerStatus] = asOwner[i];
      assert.equal(ownerLabel, label, "the two sequences diverged");
      assert.ok(ok(crewStatus), `crew must be able to ${label} (${route}): ${crewStatus}`);
      assert.ok(ok(ownerStatus), `the owner control failed on ${route}, so the crew result above proves nothing: ${ownerStatus}`);
    }
  });

  test("the diary gate is on the status field, and not on the route", async () => {
    /**
     * AUDIT L81. A submitted diary is a claim; an approved one is the record,
     * and the portal presents an approval rate as oversight.
     *
     * BOTH ROWS ARE IN THIS ONE TEST ON PURPOSE.
     *
     * A gate that locked the whole of PATCH /projects/diaries/:id would satisfy
     * the 403 row perfectly, and "diary editing is now manager-only" is a worse
     * defect than the one being fixed — it would take the field product's
     * central record away from the only people who fill it in. So the allowed
     * row and the refused row run here against the SAME route, as the same
     * role, differing only in whether the body carries `status`. Neither row
     * means anything without the other.
     *
     * The POST pair is the same argument applied to creation. DiarySchema's
     * `status` is REQUIRED on create, so an ungated POST would let a crew
     * member refused the transition simply create the diary already approved,
     * and the PATCH gate would be decoration. Gating POST reaches beyond the
     * letter of the decision, which named PATCH; it is called out in the PR
     * body for that reason, and the draft row beside it is what shows the cost
     * is nil — crew still create diaries, which is all either client does.
     */
    const seeded = await seed<{ diary: { id: string } }>("POST", "/projects/diaries", {
      siteId, status: "draft", summary: "crew diary, for the field gate", reportPeriod: "daily",
    }, crewToken);
    const diaryId = seeded.body.diary?.id;
    assert.ok(diaryId, "the field-gate test has no diary to probe, so nothing below measures anything");

    const newDiary = (status: string) => ({
      siteId, status, summary: `field gate ${status}`, reportPeriod: "daily",
    });

    /**
     * Ordered so that the owner control never consumes what a later row needs:
     * the content edits run while the diary is still a draft, and the approval
     * rows run last on it.
     */
    const probes: Array<{ label: string; method: string; path: string; body: unknown; crewAllowed: boolean }> = [
      { label: "edit a diary's content, no status in the body", method: "PATCH", path: `/projects/diaries/${diaryId}`, body: { summary: "corrected on site" }, crewAllowed: true },
      { label: "create a diary as a draft", method: "POST", path: "/projects/diaries", body: newDiary("draft"), crewAllowed: true },
      { label: "create a diary already approved", method: "POST", path: "/projects/diaries", body: newDiary("approved"), crewAllowed: false },
      { label: "move a diary to approved", method: "PATCH", path: `/projects/diaries/${diaryId}`, body: { status: "approved" }, crewAllowed: false },
    ];
    assert.equal(probes.length, EXPECTED_FIELD_PROBES, "the field-gate population changed — see EXPECTED_FIELD_PROBES");

    for (const { label, method, path: p, body, crewAllowed } of probes) {
      const asCrew = await req<{ error?: string }>(method, p, body, crewToken);
      const asOwner = await req<{ error?: string }>(method, p, body, ownerToken);
      const route = `${method} ${p.replace(/\/[0-9a-f-]{8,}/gi, "/:id")}`;
      FIELD.push({ label, route, crew: asCrew.status, owner: asOwner.status });

      if (crewAllowed) {
        assert.ok(
          ok(asCrew.status),
          `crew must be able to ${label} (${route}): ${asCrew.status} ${JSON.stringify(asCrew.body)} — a gate at the route rather than the field is the likely cause`
        );
      } else {
        assert.equal(
          asCrew.status, 403,
          `crew must be refused: ${label} (${route}): ${asCrew.status} ${JSON.stringify(asCrew.body)}`
        );
      }
      assert.ok(
        ok(asOwner.status),
        `the owner control failed on ${route} (${label}), so the crew result above proves nothing: ${asOwner.status} ${JSON.stringify(asOwner.body)}`
      );
    }

    // The claim, stated once rather than inferred from the loop: this route
    // answered BOTH ways for the same role. If it had not, one of the two
    // halves of the gate is missing.
    const patchRows = FIELD.filter((r) => r.route.startsWith("PATCH"));
    assert.ok(patchRows.some((r) => ok(r.crew)), "crew were allowed nothing on PATCH /projects/diaries/:id — the gate is at the route");
    assert.ok(patchRows.some((r) => r.crew === 403), "crew were refused nothing on PATCH /projects/diaries/:id — there is no gate");
  });

  /**
   * Seeded by the two ownership tests below: one row of each authored kind
   * written by the OWNER and one written by the CREW member, on the same site.
   * Two authors is the whole point — the old table's every write was a crew
   * member writing their own row, so it could not see either defect.
   */
  type Pair = { kind: string; route: string; patch: (who: string) => unknown; ownerId: string; crewId: string };
  const PAIRS: Pair[] = [];

  test("two authors, one site: the rows both roles can see are seeded", async () => {
    const tplRes = await seed<{ template: { id: string } }>(
      "POST", "/inspection-templates", { name: `Parity checklist ${runId}`, items: ["Edge protection"] }, ownerToken
    );
    const templateId = tplRes.body.template.id;

    const author = async (p: string, body: unknown, token: string, key: string): Promise<string> => {
      const res = await seed<Record<string, { id: string }>>("POST", p, body, token);
      const id = res.body[key]?.id;
      assert.ok(id, `seeding ${p} returned no ${key}.id: ${JSON.stringify(res.body)}`);
      return id;
    };

    const both = async (
      kind: string, route: string, key: string, body: (who: string) => unknown, patch: (who: string) => unknown
    ) => {
      const ownerId = await author(route, body("owner"), ownerToken, key);
      const crewId = await author(route, body("crew"), crewToken, key);
      assert.notEqual(ownerId, crewId, `the two ${kind} rows are the same row, so no comparison below means anything`);
      PAIRS.push({ kind, route, patch, ownerId, crewId });
    };

    await both("entry", "/projects/entries", "entry",
      (who) => ({ siteId, date: TODAY, notes: `${who} authored this entry`, weather: "Fine", crewCount: "3" }),
      (who) => ({ notes: `${who} edited this entry` }));
    await both("incident", "/incidents", "incident",
      (who) => ({ siteId, date: TODAY, severity: "near-miss", description: `${who} authored this incident` }),
      (who) => ({ correctiveAction: `${who} edited this incident` }));
    await both("inspection", "/inspections", "inspection",
      (who) => ({ siteId, templateId, name: `${who} inspection`, date: TODAY,
                  results: [{ item: "Edge protection", passed: true, notes: "", na: false, photos: [] }], status: "complete" }),
      (who) => ({ areaInspected: `${who} edited this inspection` }));
    await both("delivery", "/deliveries", "delivery",
      (who) => ({ siteId, date: TODAY, supplier: "Placemakers", items: ["Timber"], quantity: "20", notes: `${who} authored this docket` }),
      (who) => ({ notes: `${who} edited this docket` }));

    assert.equal(PAIRS.length, 4, "the authored-record population changed — the two tests below iterate it");
  });

  test("crew see every row in the company, not only their own — compared by id, with no site membership", async () => {
    /**
     * Defect 1, the read side, and the assertion shape the decision asked for.
     *
     * `listEntries` scoped crew to `owner_email = me OR a site_members row`,
     * and a company-level invitation creates no site_members row — so a crew
     * member's view of the week was their own third of it, silently. The old
     * table could not see this: it measured a 200 on fifteen GETs, and a 200
     * returning a filtered subset is indistinguishable from a 200 returning
     * everything. So this compares the RETURNED IDS between the two roles.
     *
     * THE PRECONDITION IS STATED HERE, NOT INHERITED
     *
     * The crew member in this file was created by a SITE invitation, so a
     * site_members row exists — which means a green read could have been
     * coming from membership rather than from company scope, and the whole
     * point of the fix would be unmeasured. Relying on the refusals test below
     * to have removed it first would make this test depend on declaration
     * order, so instead it removes the membership itself, proves it was there
     * to remove (otherwise "zero rows remain" passes when the WHERE clause is
     * wrong), proves it is gone, and puts it back afterwards so the refusals
     * test still has a membership to revoke.
     *
     * site_members is FORCE RLS as of migration 025, so the read and the
     * delete run inside a transaction with app.company_id set — on the bare
     * pool they would match no rows and this precondition would be theatre.
     */
    const withTenantCtx = async <T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };

    // member_email is deliberately NOT case-normalised (migration 031), so the
    // comparison is case-insensitive here as it is in sameEmail.
    const memberships = await withTenantCtx((c) =>
      c.query<{ site_id: string; role: string; invited_by: string }>(
        `SELECT site_id, role, invited_by FROM site_members WHERE LOWER(member_email) = LOWER($1)`, [CREW]
      ).then((r) => r.rows)
    );
    assert.ok(
      memberships.length > 0,
      "the crew member has no site_members row to remove, so removing it proves nothing about where their visibility comes from"
    );

    const remaining = await withTenantCtx(async (c) => {
      await c.query(`DELETE FROM site_members WHERE LOWER(member_email) = LOWER($1)`, [CREW]);
      const left = await c.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM site_members WHERE LOWER(member_email) = LOWER($1)`, [CREW]
      );
      return left.rows[0].n;
    });
    assert.equal(remaining, 0, "the crew member still has a site membership, so the reads below do not prove company-wide visibility");

    try {
      const lists: Array<[string, string, string]> = [
        ["sites", "/projects/sites", "sites"],
        ["diary entries", "/projects/entries", "entries"],
        ["incidents", "/incidents", "incidents"],
        ["inspections", "/inspections", "inspections"],
        ["deliveries", "/deliveries", "deliveries"],
      ];
      assert.equal(lists.length, EXPECTED_PARITY_KINDS, "the parity population changed — see EXPECTED_PARITY_KINDS");

      for (const [label, route, key] of lists) {
        const asCrew = await seed<Record<string, Array<{ id: string }>>>("GET", route, undefined, crewToken);
        const asOwner = await seed<Record<string, Array<{ id: string }>>>("GET", route, undefined, ownerToken);
        const crewIds = idsOf(asCrew.body[key]);
        const ownerIds = idsOf(asOwner.body[key]);
        PARITY.push({ label, route: `GET ${route}`, crewIds: crewIds.length, ownerIds: ownerIds.length, same: crewIds.join() === ownerIds.join() });

        // The owner control first: if the owner sees nothing, two empty lists
        // are "the same rows" and this test would pass having measured nothing.
        assert.ok(ownerIds.length > 0, `the owner sees no ${label}, so comparing the two lists proves nothing`);
        assert.deepEqual(crewIds, ownerIds, `crew and the owner do not receive the same ${label}: crew ${crewIds.length}, owner ${ownerIds.length}`);
      }

      // And the specific rows, named — set equality holds if BOTH roles were
      // wrongly narrowed in the same way, so this says what must be in there.
      const entryIds = idsOf((await seed<{ entries: Array<{ id: string }> }>("GET", "/projects/entries", undefined, crewToken)).body.entries);
      const entryPair = PAIRS.find((x) => x.kind === "entry");
      assert.ok(entryPair, "the entry pair was not seeded");
      assert.ok(entryIds.includes(entryPair.ownerId), "crew cannot see the entry the OWNER wrote — this is the read-side defect");
      assert.ok(entryIds.includes(entryPair.crewId), "crew cannot see their own entry, which is a different and worse problem");

      const siteIds = idsOf((await seed<{ sites: Array<{ id: string }> }>("GET", "/projects/sites", undefined, crewToken)).body.sites);
      assert.ok(siteIds.includes(siteId), "crew cannot see the site they work on without a site_members row");
    } finally {
      // Restore the membership so the refusals test below still has one to
      // revoke. In a `finally` so a failed assertion above does not cascade
      // into an unrelated failure there.
      for (const m of memberships) {
        await withTenantCtx((c) => c.query(
          `INSERT INTO site_members (site_id, member_email, role, invited_by, company_id)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (site_id, member_email) DO NOTHING`,
          [m.site_id, CREW, m.role, m.invited_by, companyId]
        ));
      }
    }
  });

  test("crew edit only what they created, and a role above crew edits anything", async () => {
    /**
     * Defect 2, the write side, and the one the approved permission table could
     * not have caught: every write it measured was a crew member writing their
     * OWN row, so nothing exercised crew touching somebody else's. Two of these
     * stores (incidents, inspections) had no authorship check at all on their
     * Postgres path while their in-memory twins had one — AUDIT L89, green
     * suite, open door.
     *
     * FIVE PROBES PER RECORD TYPE, AND WHY EACH IS THERE
     *
     *   crew PATCH own          2xx  — the capability, which must survive
     *   crew PATCH owner's      403  — the defect
     *   crew DELETE owner's     403  — the defect, destructively
     *   owner PATCH owner's     2xx  — the row crew just failed to DELETE is
     *                                  still there, and the route still works
     *   owner PATCH crew's      2xx  — "manager: edit everything", and proof
     *                                  the gate is crew-specific rather than
     *                                  an ownership rule for everybody
     *
     * The fourth is the one that is easy to leave out and is doing real work: a
     * 403 on a DELETE is indistinguishable from a 403 on a row that was already
     * gone, so without an edit of that same row afterwards the refusal is not
     * measured, only the status code.
     */
    assert.equal(PAIRS.length, 4, "the authored-record pairs were not seeded, so nothing below is measuring a gate");

    for (const { kind, route, patch, ownerId, crewId } of PAIRS) {
      const probes: Array<{ label: string; method: string; id: string; token: string; who: "crew" | "owner"; crewAllowed: boolean }> = [
        { label: `crew edit the ${kind} they wrote`, method: "PATCH", id: crewId, token: crewToken, who: "crew", crewAllowed: true },
        { label: `crew edit somebody else's ${kind}`, method: "PATCH", id: ownerId, token: crewToken, who: "crew", crewAllowed: false },
        { label: `crew delete somebody else's ${kind}`, method: "DELETE", id: ownerId, token: crewToken, who: "crew", crewAllowed: false },
        { label: `the owner edit their own ${kind}, after crew failed to delete it`, method: "PATCH", id: ownerId, token: ownerToken, who: "owner", crewAllowed: true },
        { label: `the owner edit the ${kind} CREW wrote`, method: "PATCH", id: crewId, token: ownerToken, who: "owner", crewAllowed: true },
      ];

      for (const { label, method, id, token, who, crewAllowed } of probes) {
        const body = method === "PATCH" ? patch(who) : undefined;
        const res = await req<{ error?: string }>(method, `${route}/${id}`, body, token);
        const shown = `${method} ${route}/:id`;

        if (who === "crew") {
          OWNERSHIP.push({ label, route: shown, crew: res.status, owner: 0, crewAllowed });
          if (crewAllowed) {
            assert.ok(ok(res.status), `${label} (${shown}) must be allowed: ${res.status} ${JSON.stringify(res.body)}`);
          } else {
            assert.equal(
              res.status, 403,
              `${label} (${shown}) must be refused with 403: ${res.status} ${JSON.stringify(res.body)} — 404 means the store narrowed it but requireOwnRecord did not run; 200 means neither did`
            );
          }
        } else {
          OWNERSHIP.push({ label, route: shown, crew: 0, owner: res.status, crewAllowed: true });
          assert.ok(
            ok(res.status),
            `${label} (${shown}) must be allowed, or the crew refusals above could be a broken route rather than a gate: ${res.status} ${JSON.stringify(res.body)}`
          );
        }
      }
    }

    assert.equal(OWNERSHIP.length, EXPECTED_OWNERSHIP_PROBES, "the ownership population changed — see EXPECTED_OWNERSHIP_PROBES");
  });

  test("timesheets are the exception: crew see only their own, the owner sees everyone's", async () => {
    /**
     * The carve-out, named in the decision: pay information, not a shared site
     * record. Both rules are own-only for crew — which makes this the one
     * population where the two roles must NOT receive the same rows, and so
     * the control has to run the other way round: the owner must see the crew
     * member's timecard, or "crew see fewer rows" would pass just as well on a
     * route that returned nothing to anybody.
     *
     * AUDIT L90: the clause this replaced ORed in site_members, so a crew
     * member on a shared site could read a colleague's hours.
     */
    const card = async (token: string, who: string): Promise<string> => {
      const res = await seed<{ timecard: { id: string } }>("POST", "/crew/timecards", {
        siteId, workerName: who, date: TODAY, startTime: "07:00", endTime: "15:30", breakMinutes: 30, hoursRegular: 8,
      }, token);
      assert.ok(res.body.timecard?.id, `seeding a timecard for ${who} returned no id`);
      return res.body.timecard.id;
    };
    const ownerCard = await card(ownerToken, `owner ${runId}`);
    const crewCard = await card(crewToken, `crew ${runId}`);
    assert.notEqual(ownerCard, crewCard, "the two timecards are the same row");

    const asCrew = await seed<{ timecards: Array<{ id: string }> }>("GET", "/crew/timecards", undefined, crewToken);
    const asOwner = await seed<{ timecards: Array<{ id: string }> }>("GET", "/crew/timecards", undefined, ownerToken);
    const crewIds = idsOf(asCrew.body.timecards);
    const ownerIds = idsOf(asOwner.body.timecards);
    PARITY.push({ label: "timesheets — the carve-out, which must NOT match", route: "GET /crew/timecards", crewIds: crewIds.length, ownerIds: ownerIds.length, same: crewIds.join() === ownerIds.join() });

    // The control, first: the owner sees both, so the route works and is
    // returning more than nothing.
    assert.ok(ownerIds.includes(ownerCard), "the owner cannot see their own timecard, so nothing below is measured");
    assert.ok(ownerIds.includes(crewCard), "the owner cannot see the crew member's timecard — a manager reviewing the week's hours is why this record exists");
    // Then the carve-out.
    assert.ok(crewIds.includes(crewCard), "crew cannot see their own timecard");
    assert.ok(!crewIds.includes(ownerCard), "crew can read somebody else's timecard — this is pay information (AUDIT L90)");
    assert.notDeepEqual(crewIds, ownerIds, "crew and the owner receive the same timecards, so the carve-out is not applied");
  });

  test("crew are refused the four exceptions, and the owner is not, on the same routes", async () => {
    /**
     * Invitation, site deletion, company settings and the supervisor
     * dashboard. Each probe runs as crew and then as the owner against the SAME
     * route and, where it is destructive, the SAME resource — so the 403 cannot
     * be a deleted route and the 200 cannot be a removed gate.
     *
     * The destructive probes are ordered last within the list for the same
     * reason the entry deletion is last above: the owner control consumes the
     * thing being refused.
     */
    const disposable = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Disposable Site ${runId}`, address: "2 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
      ownerToken
    );
    const disposableId = disposable.body.site.id;

    // An invitation the owner can then revoke, so the DELETE probe has a real id.
    const revokeTarget = `crew-perm-revoke-${runId}@example.test`;
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [revokeTarget], role: "crew" }, ownerToken);
    const listed = await seed<{ invites: Array<{ id: string; invitedEmail: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const revokeId = listed.body.invites.find((i) => i.invitedEmail.toLowerCase() === revokeTarget)?.id;
    assert.ok(revokeId, `no revocable invitation to probe with: ${JSON.stringify(listed.body.invites)}`);

    /**
     * A real inspection with a real signature on it, so the void probe has a
     * target that exists and the owner control actually voids something rather
     * than collecting a 404 from the store.
     *
     * Both are created BY THE CREW MEMBER on purpose. Crew do the inspecting
     * and crew sign what they inspected — that is the whole point of the
     * capture app — and it is the retraction, not the record, that AUDIT L91
     * moved to manager+. Seeding them as crew asserts that distinction as a
     * fact of this suite rather than leaving it to the comment.
     */
    const inspection = await seed<{ inspection: { id: string } }>(
      "POST", "/inspections",
      { siteId, name: `Crew Perm Inspection ${runId}`, date: "2025-01-01" },
      crewToken
    );
    const inspectionId = inspection.body.inspection.id;
    const signed = await seed<{ signature: { id: string } }>(
      "POST", `/inspections/${inspectionId}/signatures`,
      { role: "inspector", signerName: `Crew Perm Inspector ${runId}`, path: "M0 0 L10 10", viewBox: "0 0 100 50" },
      crewToken
    );
    const signatureId = signed.body.signature.id;

    const probes: Array<{ label: string; method: string; path: string; body?: unknown }> = [
      // ── Exception 1: crew cannot invite anyone ────────────────────────────
      { label: "invite someone to a site", method: "POST", path: `/projects/sites/${siteId}/invites`, body: { emails: [`crew-perm-probe-${runId}@example.test`], role: "crew" } },
      { label: "see who has been invited to a site", method: "GET", path: `/projects/sites/${siteId}/invites` },
      { label: "invite someone to the company", method: "POST", path: "/company/members/invite", body: { emails: [`crew-perm-co-${runId}@example.test`], companyRole: "crew" } },
      { label: "see the company's pending invitations", method: "GET", path: "/company/invites" },
      { label: "list the company's members", method: "GET", path: "/company/members" },
      { label: "list a site's members", method: "GET", path: `/projects/sites/${siteId}/members` },
      // ── Exception 3: crew cannot change company settings ──────────────────
      { label: "read the company profile", method: "GET", path: "/company/profile" },
      { label: "change the company profile", method: "PATCH", path: "/company/profile", body: { name: `Crew Perm Co ${runId}` } },
      { label: "change somebody's company role", method: "PATCH", path: `/company/members/${encodeURIComponent(CREW)}/role`, body: { companyRole: "crew" } },
      // ── The supervisor dashboard ──────────────────────────────────────────
      { label: "the supervisor dashboard's own route", method: "GET", path: "/projects/reports/supervisor" },
      { label: "the supervisor summary aggregate", method: "GET", path: "/projects/summary" },
      // ── Exception 2: crew cannot remove a site. Also creating one. ────────
      { label: "create a site", method: "POST", path: "/projects/sites", body: { name: `Probe Site ${runId}`, address: "3 Main St", client: "ACME", startDate: "2025-01-01", status: "active" } },
      { label: "delete a site", method: "DELETE", path: `/projects/sites/${disposableId}` },
      { label: "revoke an invitation", method: "DELETE", path: `/projects/sites/${siteId}/invites/${revokeId}` },
      // ── AUDIT L91: crew cannot retract a signature they may give ─────────
      // Destructive in the sense that matters here: the owner control is the
      // only caller of this probe's resource, and it consumes it. Grouped with
      // the destructive probes for that reason, not because the row is deleted
      // — voidSignature stamps voided_at and voided_reason and keeps the row.
      { label: "void a signature", method: "POST", path: `/inspections/${inspectionId}/signatures/${signatureId}/void`, body: { reason: "signed by the wrong person" } },
      // Last of all: the owner control removes the crew member's own site
      // membership, which nothing below may depend on.
      { label: "remove somebody from a site", method: "DELETE", path: `/projects/sites/${siteId}/members/${encodeURIComponent(CREW)}` },
    ];
    assert.equal(probes.length, EXPECTED_REFUSALS, "the refusal population changed — see EXPECTED_REFUSALS");

    for (const { label, method, path: p, body } of probes) {
      const asCrew = await req<{ error?: string }>(method, p, body, crewToken);
      const asOwner = await req<{ error?: string }>(method, p, body, ownerToken);
      const route = `${method} ${p.replace(/\/[0-9a-f-]{8,}/gi, "/:id").replace(/\/[^/]*%40[^/]*/gi, "/:email")}`;
      REFUSALS.push({ label, route, crew: asCrew.status, owner: asOwner.status });
      assert.equal(asCrew.status, 403, `crew must be refused ${label} (${route}): ${asCrew.status} ${JSON.stringify(asCrew.body)}`);
      assert.ok(ok(asOwner.status), `the owner control failed on ${route}, so the 403 above could be a deleted route rather than a refusal: ${asOwner.status} ${JSON.stringify(asOwner.body)}`);
    }
  });

  test("the measured table is complete, and all six rows hold", () => {
    /**
     * Two distinct failures, two distinct messages.
     *
     * "did not run" and "the population changed" used to be the same assertion,
     * so a count that moved by one read as a half that had executed nothing —
     * which is exactly what happened when the write sequence grew its
     * fourteenth reachable step. Nothing is weakened: both conditions still
     * have to hold for this test to pass.
     */
    // `readonly unknown[]`: only the length matters here, and PARITY holds a
    // different row shape from the other five.
    const complete = (name: string, rows: readonly unknown[], expected: number, pin: string) => {
      assert.notEqual(
        rows.length, 0,
        `the ${name} half recorded nothing at all, so its own test failed before reaching the point where it ` +
        `records rows. The failure to fix is that test's, above — not this count.`
      );
      assert.equal(
        rows.length, expected,
        `the ${name} population changed: ${rows.length} rows against ${pin} = ${expected}. Name the row that ` +
        `moved and why before changing the number.`
      );
    };

    complete("read", READS, EXPECTED_READS, "EXPECTED_READS");
    complete("write", WRITES, EXPECTED_WRITE_STEPS, "EXPECTED_WRITE_STEPS");
    complete("refusal", REFUSALS, EXPECTED_REFUSALS, "EXPECTED_REFUSALS");
    complete("field-gate", FIELD, EXPECTED_FIELD_PROBES, "EXPECTED_FIELD_PROBES");
    // +1: the timesheet carve-out pushes its own parity row, and it is the row
    // that must NOT match. Counting it here is what stops it being dropped.
    complete("read-parity", PARITY, EXPECTED_PARITY_KINDS + 1, "EXPECTED_PARITY_KINDS + 1");
    complete("ownership", OWNERSHIP, EXPECTED_OWNERSHIP_PROBES, "EXPECTED_OWNERSHIP_PROBES");

    const lines: string[] = [];
    const emit = (heading: string, rows: Row[]) => {
      lines.push(`\n  ${heading}`);
      for (const r of rows) {
        lines.push(`    ${r.crew === 403 ? "403" : String(r.crew).padEnd(3)}  ${String(r.owner).padEnd(3)}  ${r.route}  — ${r.label}`);
      }
    };
    lines.push("\n  CREW PERMISSIONS, MEASURED AGAINST POSTGRES  (crew / owner)");
    emit("operational reads — crew must be allowed", READS);
    emit("operational writes — crew must be allowed", WRITES);
    emit("the exceptions — crew must be refused", REFUSALS);
    emit("the diary status field — crew allowed and refused on the same route", FIELD);
    emit("the ownership gate — crew edit only what they wrote", OWNERSHIP);
    // Printed differently because it is the only population whose measurement
    // is not a status code. Row counts and whether the id sets matched.
    lines.push("\n  what each role RECEIVED, by id  (crew rows / owner rows / same?)");
    for (const r of PARITY) {
      lines.push(`    ${String(r.crewIds).padEnd(4)} ${String(r.ownerIds).padEnd(4)} ${r.same ? "same" : "DIFFER"}  ${r.route}  — ${r.label}`);
    }
    console.log(lines.join("\n"));

    // The three rows, as claims rather than as a list of individual asserts.
    assert.ok([...READS, ...WRITES].every((r) => ok(r.crew)), "crew were refused an operational route");
    assert.ok(REFUSALS.every((r) => r.crew === 403), "crew were admitted to an exception");
    // FIELD is not blanket-claimed in either direction — that is the point of
    // it. What holds across it is the owner control, and that both answers
    // occur, which is asserted in its own test.
    assert.ok([...READS, ...WRITES, ...REFUSALS, ...FIELD].every((r) => ok(r.owner)), "the owner was refused something, so some control above is not a control");

    // The two new claims. OWNERSHIP rows carry their own expectation, so the
    // claim across the population is that each row answered the way its
    // expectation says — and that BOTH answers occur, which is what stops a
    // blanket refusal passing as a gate.
    assert.ok(
      OWNERSHIP.filter((r) => r.crew !== 0).every((r) => (r.crewAllowed ? ok(r.crew) : r.crew === 403)),
      "an ownership probe answered the wrong way for crew"
    );
    assert.ok(OWNERSHIP.some((r) => r.crew !== 0 && ok(r.crew)), "crew were allowed no edit at all — the gate is refusing them their own rows");
    assert.ok(OWNERSHIP.some((r) => r.crew === 403), "crew were refused no edit at all — there is no ownership gate");
    assert.ok(OWNERSHIP.filter((r) => r.owner !== 0).every((r) => ok(r.owner)), "the owner was refused an edit, so the crew refusals are not controlled");

    // Every shared record type matched by id; the carve-out did not. Both
    // directions asserted, because "all the same" and "all different" are each
    // a way for this to be vacuous.
    const shared = PARITY.filter((r) => r.route !== "GET /crew/timecards");
    assert.ok(shared.length === EXPECTED_PARITY_KINDS, "the parity population lost a row");
    assert.ok(shared.every((r) => r.same), "crew and the owner did not receive the same rows for a shared record type");
    assert.ok(PARITY.some((r) => !r.same), "every population matched, including timesheets — the carve-out is not applied");
  });

}
