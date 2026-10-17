/**
 * The invitation-accept carve-out on projectsRouter — AUDIT L66.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM company-rbac.test.ts
 *
 * company-rbac.test.ts already has a "crew" case, and it passes, and it did not
 * catch this. The reason is worth stating because it is the whole point of the
 * file you are reading: that suite builds its crew member by registering WITHOUT
 * an invite token, which routes/auth.ts handles by creating a solo company and
 * making them its OWNER. The invitation is then accepted at rank owner(3), sails
 * through `requireAtLeast("viewer")`, and the account is demoted to crew only
 * afterwards. So the suite exercised accept-as-owner and never accept-as-crew,
 * which is the only journey a real invitee takes.
 *
 * The real journey registers WITH an invite token: companyId "" and companyRole
 * "crew" from the first moment. If acceptance does not complete during that
 * registration — a stale link, a lapsed invitation, a second invitation sent
 * later — routes/auth.ts deliberately falls through on the stated grounds that
 * "the user simply lands with no company yet and can retry the invite". The
 * retry was a 403, so the account was stranded with no route back by any means:
 * not the app, not the portal, not the emailed link, not a fresh invitation.
 *
 * These tests are therefore written against the orphan state specifically, and
 * each one carries its own positive control, because "crew can reach the accept
 * route" and "the gate never ran at all" are indistinguishable from a 200 alone.
 *
 * WHAT CHANGED IN PHASE 1b, AND WHY THIS FILE STILL EXISTS
 *
 * The carve-out is gone. The blanket gate it was cut out of is gone too: the
 * router now gates its own paths only, operational routes ask for identity, and
 * the routes that need rank say so individually. So there is no longer an exact
 * path to match loosely and no "adjacent path" failure mode to exclude — the
 * test that pinned that mechanism has been replaced by one that pins the
 * PROPERTY the mechanism existed for, which is the thing worth keeping: an
 * account stranded with no company can still reach acceptance, and the gates
 * around it are still live.
 *
 * The positive controls had to change with it. `GET /projects/sites` was the
 * control for "crew rank is genuinely below this router's gate", and crew now
 * reach it by design — using it would assert the defect. The controls below use
 * routes that still refuse crew deliberately: the supervisor report, and
 * creating a site.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      `${baseUrl}/api${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T });
          } catch {
            reject(new Error(`Non-JSON (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** A setup request whose response is checked, so a broken seed fails at the seed. */
async function seed<T = unknown>(...args: Parameters<typeof req>): Promise<{ status: number; body: T }> {
  const res = await req<T>(...args);
  assert.ok(
    res.status >= 200 && res.status < 300,
    `seed request failed: ${args[0]} ${args[1]} -> ${res.status} ${JSON.stringify(res.body)}`
  );
  return res;
}

let _phoneSeq = 0;
function nextPhone() { return `+615${String(++_phoneSeq).padStart(8, "0")}`; }

/**
 * Register + verify a user. `extra` goes into the final verify call, which is
 * where routes/auth.ts reads `inviteToken` — passing it is what produces an
 * invited account (companyId "", companyRole "crew") rather than a solo owner.
 */
async function registerUser(
  email: string,
  name: string,
  opts: { companyName?: string; inviteToken?: string } = {}
): Promise<string> {
  const regBody: Record<string, string> = {
    email,
    phone: nextPhone(),
    fullName: name,
    password: "Password123!!",
  };
  if (opts.companyName) regBody.companyName = opts.companyName;
  const regRes = await req<{ devCodes?: { emailCode: string } }>("POST", "/auth/register", regBody);
  assert.equal(regRes.status, 200, `register ${email} failed: ${JSON.stringify(regRes.body)}`);
  const emailCode = regRes.body.devCodes!.emailCode;

  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode }
  );
  assert.equal(veRes.status, 200, `verify-email ${email} failed: ${JSON.stringify(veRes.body)}`);
  const smsCode = veRes.body.devCodes!.smsCode;

  const verifyBody: Record<string, string> = { email, smsCode };
  if (opts.inviteToken) verifyBody.inviteToken = opts.inviteToken;
  const verRes = await req<{ token: string }>("POST", "/auth/register/verify", verifyBody);
  assert.equal(verRes.status, 201, `verify ${email} failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
}

/** The orphan state: an account created from an invitation that did not complete. */
async function registerOrphanedInvitee(email: string, name: string): Promise<string> {
  // A syntactically valid token that resolves to nothing — the stale-link case.
  // routes/auth.ts treats "not_found" as non-fatal, so the account is created
  // with no company and crew rank. This is the state under test.
  const token = await registerUser(email, name, { inviteToken: "0".repeat(64) });
  const me = await req<{ user: { companyId: string; companyRole: string } }>(
    "GET", "/auth/me", undefined, token
  );
  assert.equal(me.status, 200, `/auth/me failed: ${JSON.stringify(me.body)}`);
  assert.equal(
    me.body.user.companyRole, "crew",
    "precondition: an invited signup must land at crew rank, or this file is testing the wrong thing"
  );
  assert.equal(
    me.body.user.companyId, "",
    "precondition: an invited signup whose acceptance failed must land with no company"
  );
  return token;
}

async function inviteCompanyMember(ownerToken: string, email: string, companyRole: string): Promise<string> {
  const res = await seed<{ results: Array<{ token?: string }> }>(
    "POST", "/company/members/invite", { emails: [email], companyRole }, ownerToken
  );
  assert.equal(res.body.results.length, 1, `expected exactly 1 invite result, got ${res.body.results.length}`);
  const token = res.body.results[0]?.token;
  assert.ok(token, `invite for ${email} returned no token: ${JSON.stringify(res.body)}`);
  return token;
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

test("an orphaned invitee can retry acceptance, and the gate around it is still live", async () => {
  const ownerToken = await registerUser("owner@l66.test", "Owner", { companyName: "L66 Co" });
  const orphanToken = await registerOrphanedInvitee("orphan@l66.test", "Orphan");

  // POSITIVE CONTROL, same router, same run: a rank gate is real and this token
  // is genuinely below it. Without these two lines a 200 on the accept route
  // below would be consistent with every gate having been deleted entirely,
  // which is exactly how L66 would be "fixed" wrongly.
  //
  // The route is the supervisor report rather than GET /projects/sites, which
  // this test used until Phase 1b: crew reach the site list by design now, so
  // asserting a 403 there would re-assert the defect.
  const ownerReport = await req("GET", "/projects/reports/supervisor", undefined, ownerToken);
  assert.equal(ownerReport.status, 200, "control: an owner must still reach the supervisor report");
  const orphanReport = await req<{ error?: string }>("GET", "/projects/reports/supervisor", undefined, orphanToken);
  assert.equal(orphanReport.status, 403, "control: crew rank must still be refused the supervisor report");

  // The property: a fresh invitation, retried by the stranded account.
  const inviteToken = await inviteCompanyMember(ownerToken, "orphan@l66.test", "crew");
  const accept = await req<{ companyId?: string; companyRole?: string; token?: string; error?: string }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, orphanToken
  );
  assert.equal(
    accept.status, 200,
    `a stranded invitee must be able to accept an invitation: ${accept.status} ${JSON.stringify(accept.body)}`
  );

  // Reaching the handler is not the same as being attached to the company, and
  // a 200 from a route that did nothing would satisfy the assertion above.
  assert.equal(accept.body.companyRole, "crew", "acceptance must stamp the invited role");
  assert.ok(accept.body.companyId, "acceptance must stamp a company id, not an empty string");
  assert.notEqual(accept.body.companyId, "", "acceptance must stamp a company id, not an empty string");

  const me = await req<{ user: { companyId: string; companyRole: string } }>(
    "GET", "/auth/me", undefined, accept.body.token
  );
  assert.equal(me.status, 200);
  assert.equal(
    me.body.user.companyId, accept.body.companyId,
    "the company on the reissued token must match the one acceptance reported"
  );
});

/**
 * THE L66 REGRESSION TEST, in the in-memory suite.
 *
 * The replaced version of this test pinned the carve-out's string comparison —
 * that "/PROJECTS/INVITES/ACCEPT" and "/projects/invites/accept-all" were NOT
 * carved out. Both of those assertions are about a mechanism that no longer
 * exists, and both would now pass for the wrong reason (the first reaches the
 * handler, the second is a 404), which is the worst kind of green.
 *
 * What is worth pinning is the structural property the carve-out was a
 * workaround for: projectsRouter's gate applies to projectsRouter's paths and
 * to nothing mounted after it. That is the one-line difference between a crew
 * member who can work and a crew member who cannot, and it is invisible in a
 * diff — `use(mw)` and `use("/projects", mw)` look like the same line.
 */
test("the projects gate applies to its own paths and not to the routers mounted after it", async () => {
  const ownerToken = await registerUser("owner2@l66.test", "Owner", { companyName: "L66 Co 2" });
  const orphanToken = await registerOrphanedInvitee("orphan2@l66.test", "Orphan");

  // THE LEAK, as an assertion. crewRouter is mounted after projectsRouter in
  // routes/index.ts and has no rank gate of its own, so under the pathless
  // `use` this answered 403 — a crew member could not clock in. Six more
  // routers were refused the same way: push, incidents, inspections,
  // deliveries, templates, location.
  const timecards = await req<{ error?: string }>("GET", "/crew/timecards", undefined, orphanToken);
  assert.equal(
    timecards.status, 200,
    `a crew token must reach crewRouter, which projectsRouter does not own: ${timecards.status} ${JSON.stringify(timecards.body)}`
  );

  // POSITIVE CONTROL: projectsRouter's own rank gates still refuse this same
  // token in this same run. Scoping the `use` must not have turned into
  // deleting it — the 200 above and this 403 are the two halves of the fix and
  // either on its own is satisfied by a mistake.
  const create = await req<{ error?: string }>(
    "POST", "/projects/sites",
    { name: "X", address: "X", client: "X", startDate: "2026-01-01", status: "active" },
    orphanToken
  );
  assert.equal(
    create.status, 403,
    `crew must still be refused site creation: ${create.status} ${JSON.stringify(create.body)}`
  );

  // AND THE GATE IS STILL A GATE, not merely a rank check: no credential at all
  // must not reach either side of it. Without this, removing requireAuth from
  // FIELD_ACCESS would leave both assertions above green.
  const anonymous = await req<{ code?: string }>("GET", "/crew/timecards");
  assert.equal(anonymous.status, 401, "an unauthenticated request must not reach crewRouter");
  assert.equal(anonymous.body.code, "no_credential");

  const anonymousAccept = await req<{ code?: string }>("POST", "/projects/invites/accept", { token: "whatever" });
  assert.equal(anonymousAccept.status, 401, "the accept route needs identity, which is why it needs no carve-out");
  assert.equal(anonymousAccept.body.code, "no_credential");

  // OWNER CONTROL on the refused route, so the 403 is about rank and not about
  // the route being broken for everyone.
  const ownerCreate = await req("POST", "/projects/sites",
    { name: "Owner Site", address: "X", client: "X", startDate: "2026-01-01", status: "active" },
    ownerToken
  );
  assert.equal(ownerCreate.status, 201, "control: an owner must still be able to create a site");
});

test("the diary gate reads the status field and not the path, so crew keep diaries", async () => {
  /**
   * AUDIT L81. The authoritative measurement of this is against Postgres, in
   * crew-permissions-db.test.ts, which is where the phase's standard puts
   * anything touching authorisation. This one exists because that file cannot
   * run in this environment — there is no local Postgres — and a gate nobody
   * has watched execute is a gate on paper. It runs here, in-memory, on every
   * commit, and it is the red-on-revert check for the middleware itself.
   *
   * The two halves are in one test for the reason the gate is on a field at
   * all: a `use` on the diary routes would satisfy the 403 and take the field
   * product's central record away from the people who write it. The 200 is what
   * says that did not happen.
   */
  const ownerToken = await registerUser("owner4@l81.test", "Owner", { companyName: "L81 Co" });

  // A crew member who has actually JOINED the company, not the orphaned
  // invitee the tests above use: that one carries companyId "" by construction,
  // so the owner control could not see a row it created and the control would
  // fail as a 404 — a false negative that says nothing about the gate.
  const orphanToken = await registerOrphanedInvitee("crew4@l81.test", "Crew");
  const inviteToken = await inviteCompanyMember(ownerToken, "crew4@l81.test", "crew");
  const accept = await req<{ companyRole?: string; token?: string }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, orphanToken
  );
  assert.equal(accept.status, 200, `acceptance must succeed: ${JSON.stringify(accept.body)}`);
  assert.equal(accept.body.companyRole, "crew", "precondition: the token below must carry crew, or no 403 here proves anything");
  const crewToken = accept.body.token;
  assert.ok(crewToken, "acceptance must reissue a token");

  const site = await req<{ site: { id: string } }>("POST", "/projects/sites",
    { name: "L81 Site", address: "1 Field Rd", client: "ACME", startDate: "2026-01-01", status: "active" },
    ownerToken
  );
  assert.equal(site.status, 201, `seed: the owner must be able to create the site: ${JSON.stringify(site.body)}`);
  const siteId = site.body.site.id;

  // ALLOWED: crew create a diary. `status` is required by the schema and both
  // clients send "draft", which is the value that asserts nothing.
  const created = await req<{ diary: { id: string }; error?: string }>("POST", "/projects/diaries",
    { siteId, status: "draft", summary: "Crew draft", reportPeriod: "daily" },
    crewToken
  );
  assert.ok(
    created.status >= 200 && created.status < 300,
    `crew must be able to save a draft diary: ${created.status} ${JSON.stringify(created.body)}`
  );
  const diaryId = created.body.diary.id;

  // ALLOWED: crew edit its content. No `status` in the body at all.
  const edited = await req<{ error?: string }>("PATCH", `/projects/diaries/${diaryId}`,
    { summary: "Crew corrected the summary" }, crewToken
  );
  assert.ok(
    edited.status >= 200 && edited.status < 300,
    `crew must keep editing diaries — a route-level gate is the likely cause: ${edited.status} ${JSON.stringify(edited.body)}`
  );

  // REFUSED: the transition to approved, on the route that just answered 200.
  const approve = await req<{ error?: string }>("PATCH", `/projects/diaries/${diaryId}`,
    { status: "approved" }, crewToken
  );
  assert.equal(approve.status, 403, `crew must not approve a diary: ${approve.status} ${JSON.stringify(approve.body)}`);

  // REFUSED: and not reachable by creating one already approved either, which
  // would make the refusal above decoration.
  const createApproved = await req<{ error?: string }>("POST", "/projects/diaries",
    { siteId, status: "approved", summary: "Crew self-approved", reportPeriod: "daily" },
    crewToken
  );
  assert.equal(createApproved.status, 403, `crew must not create an approved diary: ${createApproved.status} ${JSON.stringify(createApproved.body)}`);

  // OWNER CONTROL, on the same route with the same body: so the two 403s are
  // about rank and not about a broken route or a rejected payload.
  const ownerApprove = await req<{ error?: string }>("PATCH", `/projects/diaries/${diaryId}`,
    { status: "approved" }, ownerToken
  );
  assert.ok(
    ownerApprove.status >= 200 && ownerApprove.status < 300,
    `control: the owner must be able to approve: ${ownerApprove.status} ${JSON.stringify(ownerApprove.body)}`
  );

  // AND the refusal is not a dead session. L73 in the other dimension — see
  // the mobile half in apps/mobile/lib/permissions.test.ts.
  const stillAlive = await req("GET", "/projects/diaries", undefined, crewToken);
  assert.equal(stillAlive.status, 200, "a 403 must not have cost the crew member their session");
});

/**
 * THE INVERSION OF THIS TEST IS THE POINT.
 *
 * Until this branch it asserted that a pre-acceptance token stayed
 * UNPRIVILEGED after acceptance, and that `/auth/refresh` was the only thing
 * that lifted it. That was a faithful test of a real defect: authorisation
 * read the token's claims, so an invitee's own credential kept saying "no
 * company, crew rank" until they replaced it, and nothing recovered on its own
 * because the refusal was a 403 and the mobile client's retry only fires on
 * 401.
 *
 * THE SESSION MODEL (`storage/authStore.ts`) closes that: authority comes from
 * the row, so the claim is never consulted and never has to be corrected. The
 * assertions below are the same measurements with the expectations flipped,
 * which is the strongest regression test available for the new model — if a
 * future change restores claim-derived authority, this file goes red on the
 * exact route and rank the defect was reported on.
 */
test("after acceptance the pre-acceptance token is immediately privileged, because authority comes from the row", async () => {
  const ownerToken = await registerUser("owner3@l66.test", "Owner", { companyName: "L66 Co 3" });
  const orphanToken = await registerOrphanedInvitee("orphan3@l66.test", "Orphan");

  // Invited as MANAGER, not crew, purely so the difference is observable. Every
  // company-scoped route sits behind `requireAtLeast("viewer")` or higher, and
  // crew ranks below all of them (AUDIT L66), so a crew invitee's before and
  // after look identical from the outside and this property cannot be measured
  // at that rank at all.
  const inviteToken = await inviteCompanyMember(ownerToken, "orphan3@l66.test", "manager");
  const accept = await req<{ companyId?: string; companyRole?: string; token?: string }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, orphanToken
  );
  assert.equal(accept.status, 200, `acceptance must succeed: ${JSON.stringify(accept.body)}`);
  assert.equal(accept.body.companyRole, "manager", "acceptance must stamp the invited role");
  assert.ok(accept.body.companyId, "acceptance must stamp a company");
  const freshToken = accept.body.token;
  assert.ok(freshToken, "acceptance must reissue a token");
  assert.notEqual(freshToken, orphanToken, "the reissued token must not be the one presented");

  // THE PROPERTY: the credential the invitee was already holding works, at the
  // rank the row now carries, with no replacement and no extra round trip. Its
  // claims still say "no company, crew" — they are seven days from expiry and
  // nothing rewrites them — and that is exactly why this is the assertion
  // worth making: it can only pass if `requireAuth` ignored them.
  const stale = await req<{ error?: string }>("GET", "/company/profile", undefined, orphanToken);
  assert.equal(
    stale.status, 200,
    `the pre-acceptance token must be honoured at the row's rank: ${stale.status} ${JSON.stringify(stale.body)}`
  );

  // CONTROL, same route, same run: the reissued token reaches it too. Without
  // this the 200 above is equally consistent with /company/profile having lost
  // its gate and admitting every caller alive — and the rank control is the
  // next assertion, not this one.
  const withFresh = await req("GET", "/company/profile", undefined, freshToken);
  assert.equal(
    withFresh.status, 200,
    `control: the reissued token must reach the same route: ${withFresh.status} ${JSON.stringify(withFresh.body)}`
  );

  // THE RANK CONTROL, in the same test, because "the row decides" is only a
  // security property if the row can still say no. An account whose row says
  // crew is refused the same route the manager row above reached — so the 200s
  // are about this user's rank and not about the gate having been removed.
  const crewOnlyToken = await registerOrphanedInvitee("crew3@l66.test", "Crew");
  const crewInvite = await inviteCompanyMember(ownerToken, "crew3@l66.test", "crew");
  const crewAccept = await req("POST", "/projects/invites/accept", { token: crewInvite }, crewOnlyToken);
  assert.equal(crewAccept.status, 200, `seed: the crew invitee must be able to accept: ${JSON.stringify(crewAccept.body)}`);
  const crewRefused = await req<{ error?: string }>("GET", "/company/profile", undefined, crewOnlyToken);
  assert.equal(
    crewRefused.status, 403,
    `a crew row must still be refused the company profile: ${crewRefused.status} ${JSON.stringify(crewRefused.body)}`
  );

  // /auth/me has always answered from the user ROW. Under the old model that
  // made the defect invisible to the obvious check — the profile screen looked
  // correct while every authorising route disagreed, so anyone diagnosing it
  // with /auth/me concluded there was no bug. Under the new model it is simply
  // the same source of truth as everything else, which is the point: there is
  // now one answer to "what may this caller do", not two.
  const me = await req<{ user: { companyId: string } }>("GET", "/auth/me", undefined, orphanToken);
  assert.equal(me.status, 200);
  assert.equal(
    me.body.user.companyId, accept.body.companyId,
    "/auth/me reads the row, so it must report the joined company even on the stale token"
  );

  // /auth/refresh still works on that token, and still mints claims carrying
  // the company — it is now a cache refresh rather than a rescue. It stays
  // asserted because the mobile client calls it immediately after accepting
  // (data-context's acceptInvite) and because it is the 401 retry path in
  // apiJson: if it ever stopped accepting a token like this one, an invitee
  // would be returned to the login screen, which is the regression that made
  // this whole model necessary.
  const refreshed = await req<{ token?: string }>("POST", "/auth/refresh", undefined, orphanToken);
  assert.equal(refreshed.status, 200, `refresh must accept the stale token: ${JSON.stringify(refreshed.body)}`);
  assert.ok(refreshed.body.token, "refresh must return a token");
  const afterRefresh = await req("GET", "/company/profile", undefined, refreshed.body.token);
  assert.equal(
    afterRefresh.status, 200,
    `the refreshed token must carry the new company: ${afterRefresh.status} ${JSON.stringify(afterRefresh.body)}`
  );
});
