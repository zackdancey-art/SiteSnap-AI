/**
 * Job numbers against the in-memory store — the twin of job-number-db.test.ts.
 *
 * WHY TWO COPIES OF THE SAME SEVEN SCENARIOS
 *
 * The same reason `clients.test.ts` and `clients-db.test.ts` both exist. The
 * DB-gated file is the authoritative one: a permissions or tenancy claim is
 * only worth making against the store production uses, because several defects
 * in this service have hidden in the gap between the two implementations (AUDIT
 * L65, L87, L88, L89, L99). This file does the thing the authoritative one
 * cannot: it runs with no Postgres, which is what makes a red-on-revert
 * reproducible on a laptop, and it is the only check on the in-memory half of
 * `updateSiteJobNumber` — the half that serves every dev install.
 *
 * THE TWO FILES MUST BE CHANGED TOGETHER. A scenario added here and not there
 * has never run against Postgres; added there and not here and the in-memory
 * store drifts, which is the original defect.
 *
 * WHAT IS BEING DEFENDED
 *
 *   1. A manager sets a job number and it reads back; crew are refused and the
 *      value does not change — while crew keep the capability they must keep,
 *      which is SEEING it on the site they are standing on.
 *   2. An over-long value is REFUSED, not truncated; a value at exactly the cap
 *      is accepted. Both in the same test, because a route that refused
 *      everything would pass the refusal half alone.
 *   3. A site created WITH a job number keeps it; a site created WITHOUT one
 *      reads back "" — not undefined and not null. One absence state.
 *   4. The empty string CLEARS it, after a control proving it was set.
 *   5. Surrounding whitespace is trimmed; internal spacing is preserved as
 *      typed, because "SITE 12 B" is a reference somebody wrote down.
 *   6. Another company's manager cannot read or change it, while their own site
 *      is both readable and changeable through the same two endpoints.
 *   7. A site in the bin takes no job-number update; a live one does.
 *
 * NO HAND-WRITTEN COUNTS. The cap is read from the route's own refusal rather
 * than restated here — see CAP below.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetClientsStoreForTests } from "../storage/clientsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { verifyAuthToken } from "../utils/authToken";

const PASSWORD = "Password123!";

/**
 * The cap, DERIVED rather than restated (AUDIT L112).
 *
 * The route owns the number; a literal `40` here would be a second statement of
 * it that could silently disagree with the schema, which is the exact failure
 * mode `assert_job_number_cap_agrees` in scripts/ci.sh exists to prevent
 * between the API and the two clients. So `before` reads it out of the route's
 * own 400 message and every length assertion below is written against that.
 */
let CAP = 0;

let server: http.Server;
let baseUrl: string;
let ownerToken: string;
let crewToken: string;
let outsiderToken: string;
let companyId: string;
let siteId: string;
let phoneSeq = 0;
let idSeq = 0;

type Answer<T> = { status: number; body: T };

const req = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
  const res = await fetch(`${baseUrl}/api${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: T;
  try { parsed = JSON.parse(text) as T; } catch { parsed = { error: text } as unknown as T; }
  return { status: res.status, body: parsed };
};

/** A request whose response is CHECKED — a silently failing seed turns every assertion below it into a test of nothing. */
const seed = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
  const res = await req<T>(method, p, body, token);
  assert.ok(res.status >= 200 && res.status < 300, `seed ${method} ${p} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

const register = async (email: string, fullName: string): Promise<string> => {
  const phone = `+615${(++phoneSeq).toString().padStart(8, "0")}`;
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

type Site = { id: string; name: string; client: string; clientId: string | null; jobNumber: string };

const newSite = async (name: string, token: string, jobNumber?: string): Promise<Site> => {
  const res = await seed<{ site: Site }>(
    "POST", "/projects/sites",
    {
      name, address: "1 Main St", client: "Typed By Hand", startDate: "2026-01-01", status: "active",
      ...(jobNumber === undefined ? {} : { jobNumber }),
    },
    token
  );
  return res.body.site;
};

/** The site as the product reports it — the in-memory stand-in for the twin's direct SELECT. */
const siteAsListed = async (id: string, token: string): Promise<Site | undefined> => {
  const list = await seed<{ sites: Site[] }>("GET", "/projects/sites", undefined, token);
  return list.body.sites.find((s) => s.id === id);
};

const setJobNumber = (id: string, jobNumber: string, token: string) =>
  req<{ site: Site; error?: string }>("PATCH", `/projects/sites/${id}/job-number`, { jobNumber }, token);

before(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetClientsStoreForTests();
  resetRateLimitStoreForTests();

  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  ownerToken = await register("jobno-mem-owner@example.test", "Job Owner");
  const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
  companyId = me.body.user.companyId;
  assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

  siteId = (await newSite("Job Number Site", ownerToken)).id;

  // The crew member, by the journey a real crew member takes. `register` alone
  // would have made them the OWNER of their own company, which is not the role
  // under test.
  await seed("POST", `/projects/sites/${siteId}/invites`, { emails: ["jobno-mem-crew@example.test"], role: "crew" }, ownerToken);
  const invites = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
  );
  const invite = invites.body.invites.find((i) => i.invitedEmail.toLowerCase() === "jobno-mem-crew@example.test");
  assert.ok(invite?.token, `no invitation listed for the crew member: ${JSON.stringify(invites.body.invites)}`);
  const registered = await register("jobno-mem-crew@example.test", "Job Crew");
  const accepted = await seed<{ token?: string; companyId: string | null }>(
    "POST", "/projects/invites/accept", { token: invite.token }, registered
  );
  assert.equal(accepted.body.companyId, companyId, "the invitation did not attach the crew member to the inviting company");
  crewToken = accepted.body.token ?? registered;

  outsiderToken = await register("jobno-mem-outsider@example.test", "Job Outsider");

  // Read the cap out of the route rather than restating it. 4096 is far past
  // any plausible cap, so the refusal is certain; the message names the number.
  const refusal = await setJobNumber(siteId, "x".repeat(4096), ownerToken);
  assert.equal(refusal.status, 400, "a 4096-character job number was not refused, so there is no cap to read");
  const found = /at most (\d+) characters/.exec(refusal.body.error ?? "");
  assert.ok(found, `the route's refusal does not name the cap: ${JSON.stringify(refusal.body)}`);
  CAP = Number(found[1]);
  assert.ok(CAP > 1 && CAP < 4096, `the cap read from the route is not usable: ${CAP}`);
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  // Only the limiter. The stores hold the company, crew member and site that
  // `before` built, and resetting them here would delete the roles every
  // scenario below is measured with.
  resetRateLimitStoreForTests();
});

test("precondition: the three tokens carry the three roles these scenarios claim", () => {
  // requireAtLeast reads the TOKEN; /auth/me reads the store. The two can
  // disagree, and only one of them gates a route — so without this the refusals
  // below could be measuring a viewer.
  const crew = verifyAuthToken(crewToken);
  const owner = verifyAuthToken(ownerToken);
  const outsider = verifyAuthToken(outsiderToken);
  assert.equal(crew?.companyRole, "crew", "the crew token does not carry companyRole crew");
  assert.equal(owner?.companyRole, "owner", "the owner token does not carry companyRole owner");
  assert.ok(outsider?.companyId && outsider.companyId !== owner?.companyId, "the outsider is in the same company, so the tenancy scenario measures nothing");
});

test("a manager sets a job number, crew cannot, and crew can still see it", async () => {
  const site = await newSite(`Set Site ${++idSeq}`, ownerToken);

  const crewAttempt = await setJobNumber(site.id, "CREW-INVENTED", crewToken);
  assert.equal(crewAttempt.status, 403, "crew set a job number");
  assert.equal((await siteAsListed(site.id, ownerToken))?.jobNumber, "", "a 403 was returned but the job number was written anyway");

  // CONTROL, same endpoint, same test: the route works for a manager, so the
  // 403 above is a gate rather than a broken route.
  const managerAttempt = await setJobNumber(site.id, "2026-NW-00123", ownerToken);
  assert.equal(managerAttempt.status, 200, "the manager cannot set a job number either");
  assert.equal(managerAttempt.body.site.jobNumber, "2026-NW-00123", "the route returned 200 with the wrong job number");
  assert.equal((await siteAsListed(site.id, ownerToken))?.jobNumber, "2026-NW-00123", "the job number did not survive a re-read");

  // And the capability crew MUST keep: they see the job number on the site they
  // are standing on. A gate that also hid the value would make the field
  // useless to the people doing the work.
  const crewView = await siteAsListed(site.id, crewToken);
  assert.ok(crewView, "crew can no longer see the site");
  assert.equal(crewView.jobNumber, "2026-NW-00123", "crew can see the site but not its job number");
});

test("a value at the cap is accepted and one character more is refused, not truncated", async () => {
  const site = await newSite(`Cap Site ${++idSeq}`, ownerToken);

  const atCap = "J".repeat(CAP);
  const ok = await setJobNumber(site.id, atCap, ownerToken);
  assert.equal(ok.status, 200, `a job number of exactly ${CAP} characters was refused`);
  assert.equal(ok.body.site.jobNumber, atCap);

  const overCap = "K".repeat(CAP + 1);
  const refused = await setJobNumber(site.id, overCap, ownerToken);
  assert.equal(refused.status, 400, `a job number of ${CAP + 1} characters was accepted`);

  // THE POINT OF THIS TEST. A truncating implementation would also return a
  // value — the first CAP characters of `overCap` — and a test that only
  // checked the status would pass. The stored value must be the PREVIOUS one,
  // untouched: a silently shortened reference is worse than a refused one,
  // because the contractor cannot tell it happened.
  const after = await siteAsListed(site.id, ownerToken);
  assert.equal(after?.jobNumber, atCap, "the over-long value was stored (truncated or whole) instead of refused");
  assert.notEqual(after?.jobNumber, overCap.slice(0, CAP), "the over-long value was truncated and stored");
});

test("a site created with a job number keeps it, and one created without reads back empty", async () => {
  const withNumber = await newSite(`With Number ${++idSeq}`, ownerToken, "INV-9981");
  assert.equal(withNumber.jobNumber, "INV-9981", "POST /projects/sites dropped the job number it was given");
  assert.equal((await siteAsListed(withNumber.id, ownerToken))?.jobNumber, "INV-9981", "the job number did not survive createSite");

  // The absence state, asserted as an EQUALITY against "" rather than as a
  // falsy check: `undefined` and `null` are both falsy and both wrong here, and
  // a client that renders `Job #${site.jobNumber}` would print "Job #undefined"
  // for one of them. This is the shape of the defect PR 2 fixes — the mobile
  // screen read the field through a cast and got undefined on every site.
  const without = await newSite(`Without Number ${++idSeq}`, ownerToken);
  assert.equal(without.jobNumber, "", "a site created with no job number did not read back as the empty string");
  assert.equal((await siteAsListed(without.id, ownerToken))?.jobNumber, "");
});

test("the empty string clears a job number", async () => {
  const site = await newSite(`Clear Site ${++idSeq}`, ownerToken, "TO-BE-CLEARED");
  // CONTROL FIRST: it really was set, so the "" below clears something.
  assert.equal((await siteAsListed(site.id, ownerToken))?.jobNumber, "TO-BE-CLEARED", "the job number was never set, so clearing it proves nothing");

  const cleared = await setJobNumber(site.id, "", ownerToken);
  assert.equal(cleared.status, 200, "clearing a job number was refused");
  assert.equal(cleared.body.site.jobNumber, "");
  assert.equal((await siteAsListed(site.id, ownerToken))?.jobNumber, "", "the job number was not cleared");
});

test("surrounding whitespace is trimmed and internal spacing is kept", async () => {
  const site = await newSite(`Trim Site ${++idSeq}`, ownerToken);

  const padded = await setJobNumber(site.id, "   12-4   ", ownerToken);
  assert.equal(padded.status, 200);
  assert.equal(padded.body.site.jobNumber, "12-4", "the job number was stored with its padding, so the search box will miss it");

  // CONTROL: trimming is not collapsing. "SITE 12 B" is a reference somebody
  // wrote on a drawing, and rewriting it to "SITE12B" would mean the number in
  // the app is not the number on the paper.
  const internal = await setJobNumber(site.id, "  SITE 12 B  ", ownerToken);
  assert.equal(internal.status, 200);
  assert.equal(internal.body.site.jobNumber, "SITE 12 B", "internal spacing was altered");

  // And a value of nothing but whitespace is a cleared field, not a one-space
  // job number that every grouping would render as a blank badge.
  const blank = await setJobNumber(site.id, "     ", ownerToken);
  assert.equal(blank.status, 200);
  assert.equal(blank.body.site.jobNumber, "", "a whitespace-only job number was stored as whitespace");
});

test("another company's manager can neither read nor change a job number", async () => {
  const site = await newSite(`Tenancy Site ${++idSeq}`, ownerToken, "PRIVATE-77");

  const outsiderAttempt = await setJobNumber(site.id, "STOLEN", outsiderToken);
  assert.equal(outsiderAttempt.status, 404, "another company's manager changed a job number");
  assert.equal((await siteAsListed(site.id, ownerToken))?.jobNumber, "PRIVATE-77", "a 404 was returned but the job number changed anyway");

  const outsiderList = await seed<{ sites: Site[] }>("GET", "/projects/sites", undefined, outsiderToken);
  assert.ok(!outsiderList.body.sites.some((s) => s.id === site.id), "another company's manager can see the site");

  // CONTROL, same two endpoints: the outsider is a working manager of their own
  // company. Without this, a token that had simply stopped authenticating would
  // satisfy both refusals above.
  const theirs = await newSite(`Outsider Site ${++idSeq}`, outsiderToken, "THEIRS-1");
  assert.equal(theirs.jobNumber, "THEIRS-1", "the outsider cannot create a site with a job number, so the refusals above measure nothing");
  const theirsSet = await setJobNumber(theirs.id, "THEIRS-2", outsiderToken);
  assert.equal(theirsSet.status, 200, "the outsider cannot set a job number on their own site");
  assert.equal((await siteAsListed(theirs.id, outsiderToken))?.jobNumber, "THEIRS-2");
});

test("a site in the bin takes no job-number update, and a live one does", async () => {
  const binned = await newSite(`Binned Site ${++idSeq}`, ownerToken, "BIN-1");
  await seed("DELETE", `/projects/sites/${binned.id}`, undefined, ownerToken);

  const attempt = await setJobNumber(binned.id, "BIN-2", ownerToken);
  assert.equal(attempt.status, 404, "a binned site accepted a job-number update");

  // The value is unchanged where the bin can still be read from, which is the
  // restore path — otherwise "404" and "edited then hidden" look identical.
  await seed("POST", `/projects/sites/${binned.id}/restore`, undefined, ownerToken);
  assert.equal((await siteAsListed(binned.id, ownerToken))?.jobNumber, "BIN-1", "the binned site's job number was changed behind the 404");

  // CONTROL, same endpoint: now that it is live again it takes the update, so
  // the 404 was the bin predicate and not a missing route.
  const live = await setJobNumber(binned.id, "BIN-2", ownerToken);
  assert.equal(live.status, 200, "a restored site still cannot take a job-number update");
  assert.equal((await siteAsListed(binned.id, ownerToken))?.jobNumber, "BIN-2");
});
