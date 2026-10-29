/**
 * Client filing against the in-memory store — the twin of clients-db.test.ts.
 *
 * WHY A SECOND COPY OF THE SAME SIX SCENARIOS
 *
 * The DB-gated file is the authoritative one: permissions and tenancy claims
 * are only worth making against the store production uses, because seven
 * defects in this service have hidden in the gap between the two
 * implementations. This file exists for the thing the authoritative one cannot
 * do — it runs with no Postgres, which is what makes a red-on-revert
 * reproducible on a laptop, and it is the only check on the in-memory halves of
 * `clientsStore` and `updateSiteClient` (the halves that serve every dev
 * install, and where `ON DELETE SET NULL` has to be re-implemented by hand
 * because there are no foreign keys).
 *
 * THE TWO FILES MUST BE CHANGED TOGETHER. A scenario added here and not there
 * is a scenario that has never run against Postgres; added there and not here
 * and the in-memory store drifts, which is the original defect.
 *
 * What is asserted directly against the database in the twin is asserted here
 * through the routes a client actually calls, which is the strongest thing
 * available without a database and is what a user would notice.
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
  const phone = `+614${(++phoneSeq).toString().padStart(8, "0")}`;
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

type Client = { id: string; name: string; siteCount?: number };
type Site = { id: string; name: string; client: string; clientId: string | null };

const newSite = async (name: string, token: string): Promise<string> => {
  const res = await seed<{ site: Site }>(
    "POST", "/projects/sites",
    { name, address: "1 Main St", client: "Typed By Hand", startDate: "2026-01-01", status: "active" },
    token
  );
  return res.body.site.id;
};

const newClient = async (name: string, token: string): Promise<string> => {
  const res = await seed<{ client: Client }>("POST", "/clients", { name }, token);
  return res.body.client.id;
};

/** The site as the product reports it — the in-memory stand-in for the twin's direct SELECT. */
const siteAsListed = async (id: string, token: string): Promise<Site | undefined> => {
  const list = await seed<{ sites: Site[] }>("GET", "/projects/sites", undefined, token);
  return list.body.sites.find((s) => s.id === id);
};

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

  ownerToken = await register("clients-mem-owner@example.test", "Clients Owner");
  const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
  companyId = me.body.user.companyId;
  assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

  siteId = await newSite("Clients Site", ownerToken);

  // The crew member, by the journey a real crew member takes. `register` alone
  // would have made them the OWNER of their own company.
  await seed("POST", `/projects/sites/${siteId}/invites`, { emails: ["clients-mem-crew@example.test"], role: "crew" }, ownerToken);
  const invites = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
  );
  const invite = invites.body.invites.find((i) => i.invitedEmail.toLowerCase() === "clients-mem-crew@example.test");
  assert.ok(invite?.token, `no invitation listed for the crew member: ${JSON.stringify(invites.body.invites)}`);
  const registered = await register("clients-mem-crew@example.test", "Clients Crew");
  const accepted = await seed<{ token?: string; companyId: string | null }>(
    "POST", "/projects/invites/accept", { token: invite.token }, registered
  );
  assert.equal(accepted.body.companyId, companyId, "the invitation did not attach the crew member to the inviting company");
  crewToken = accepted.body.token ?? registered;

  outsiderToken = await register("clients-mem-outsider@example.test", "Clients Outsider");
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
  // disagree, and only one of them gates a route.
  const crew = verifyAuthToken(crewToken);
  const owner = verifyAuthToken(ownerToken);
  const outsider = verifyAuthToken(outsiderToken);
  assert.equal(crew?.companyRole, "crew", "the crew token does not carry companyRole crew");
  assert.equal(owner?.companyRole, "owner", "the owner token does not carry companyRole owner");
  assert.ok(outsider?.companyId && outsider.companyId !== owner?.companyId, "the outsider is in the same company, so the tenancy scenario measures nothing");
});

test("crew read the client list and cannot change it, while a manager can", async () => {
  const clientId = await newClient(`Readable Builders ${++idSeq}`, ownerToken);

  // POSITIVE CONTROL on the read: crew get the row, not merely a 200.
  const crewList = await req<{ clients: Client[] }>("GET", "/clients", undefined, crewToken);
  assert.equal(crewList.status, 200, "crew cannot read the client list");
  assert.ok(crewList.body.clients.some((c) => c.id === clientId), "crew got 200 but not the client");

  const crewPost = await req("POST", "/clients", { name: "Crew Invention" }, crewToken);
  const crewPatch = await req("PATCH", `/clients/${clientId}`, { name: "Crew Rename" }, crewToken);
  const crewDelete = await req("DELETE", `/clients/${clientId}`, undefined, crewToken);
  assert.equal(crewPost.status, 403, "crew created a client");
  assert.equal(crewPatch.status, 403, "crew renamed a client");
  assert.equal(crewDelete.status, 403, "crew deleted a client");

  // THE CONTROLS, same endpoints, same test. Without these the block above
  // passes just as well with all four routes deleted.
  const renamed = `Renamed Builders ${++idSeq}`;
  const ownerPatch = await req<{ client: Client }>("PATCH", `/clients/${clientId}`, { name: renamed }, ownerToken);
  assert.equal(ownerPatch.status, 200, "the owner cannot rename a client either — the route is broken, not gated");
  assert.equal(ownerPatch.body.client.name, renamed);
  const ownerPost = await req<{ client: Client }>("POST", "/clients", { name: `Owner Invention ${++idSeq}` }, ownerToken);
  assert.equal(ownerPost.status, 201, "the owner cannot create a client either");
  const ownerDelete = await req("DELETE", `/clients/${ownerPost.body.client.id}`, undefined, ownerToken);
  assert.equal(ownerDelete.status, 200, "the owner cannot delete a client either");

  // The crew member's invented client must not exist — refused, not written.
  const after_ = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
  assert.ok(!after_.body.clients.some((c) => c.name === "Crew Invention"), "a 403 was returned but the row was written anyway");
  assert.ok(after_.body.clients.some((c) => c.id === clientId), "the client vanished, so the line above proves nothing");
});

test("a client is invisible and untouchable from another company, while that company's own is both", async () => {
  const mine = await newClient(`Tenancy Mine ${++idSeq}`, ownerToken);
  const theirs = await newClient(`Tenancy Theirs ${++idSeq}`, outsiderToken);

  const theirList = await req<{ clients: Client[] }>("GET", "/clients", undefined, outsiderToken);
  assert.equal(theirList.status, 200);
  assert.ok(!theirList.body.clients.some((c) => c.id === mine), "another company's client appeared in the list");
  assert.ok(theirList.body.clients.some((c) => c.id === theirs), "the caller's OWN client did not appear, so the negative above proves nothing");

  const crossPatch = await req("PATCH", `/clients/${mine}`, { name: "Stolen" }, outsiderToken);
  const crossDelete = await req("DELETE", `/clients/${mine}`, undefined, outsiderToken);
  assert.equal(crossPatch.status, 404, "another company renamed my client");
  assert.equal(crossDelete.status, 404, "another company deleted my client");

  // CONTROL: the same two verbs on their own client succeed.
  const ownPatch = await req("PATCH", `/clients/${theirs}`, { name: `Tenancy Theirs Renamed ${++idSeq}` }, outsiderToken);
  assert.equal(ownPatch.status, 200, "the outsider cannot patch their own client either — the 404 above is not a tenancy result");
  const ownDelete = await req("DELETE", `/clients/${theirs}`, undefined, outsiderToken);
  assert.equal(ownDelete.status, 200, "the outsider cannot delete their own client either");

  // My row survived both attempts, unrenamed.
  const mineAfter = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
  const row = mineAfter.body.clients.find((c) => c.id === mine);
  assert.ok(row, "my client was deleted by another company");
  assert.match(row.name, /^Tenancy Mine /, "my client was renamed by another company");
});

test("one builder cannot be filed twice under two spellings, while a different name is accepted", async () => {
  const name = `Metro Builders ${++idSeq}`;
  const first = await req<{ client: Client }>("POST", "/clients", { name }, ownerToken);
  assert.equal(first.status, 201);

  const dupe = await req<{ error: string; clientId: string }>(
    "POST", "/clients", { name: `  ${name.toLowerCase()}  ` }, ownerToken
  );
  assert.equal(dupe.status, 409, "the same builder was filed twice under two spellings");
  assert.equal(dupe.body.clientId, first.body.client.id, "the 409 did not name the client it collided with");

  // CONTROL: a genuinely different name on the same endpoint is accepted.
  const different = await req<{ client: Client }>("POST", "/clients", { name: `${name} North` }, ownerToken);
  assert.equal(different.status, 201, "a different name was refused too — the check is not a duplicate check");

  // Measured: exactly the two accepted names are present.
  const list = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
  const matching = list.body.clients.filter((c) => c.name.startsWith(name));
  assert.equal(matching.length, 2, "the duplicate was refused to the caller but stored anyway");
});

test("filing a site rewrites its label to the client's name, and unfiling keeps the label", async () => {
  const canonical = `Canonical Builders Pty Ltd ${++idSeq}`;
  const clientId = await newClient(canonical, ownerToken);
  const target = await newSite(`Filing Site ${++idSeq}`, ownerToken);

  const before_ = await siteAsListed(target, ownerToken);
  assert.equal(before_?.client, "Typed By Hand", "the site did not start with the free text this scenario is about");
  assert.equal(before_?.clientId ?? null, null, "a brand new site arrived already filed");

  const filed = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId }, ownerToken);
  assert.equal(filed.status, 200, "a manager cannot file a site under a client");
  assert.equal(filed.body.site.clientId, clientId);
  assert.equal(filed.body.site.client, canonical, "the free-text label was not brought into step with the client's name");

  // Stored, not just answered.
  const afterFiling = await siteAsListed(target, ownerToken);
  assert.equal(afterFiling?.clientId, clientId, "the response said filed but the stored site did not move");
  assert.equal(afterFiling?.client, canonical);

  const unfiled = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId: null }, ownerToken);
  assert.equal(unfiled.status, 200);
  assert.equal(unfiled.body.site.clientId, null, "unfiling left the site filed");
  assert.equal(unfiled.body.site.client, canonical, "unfiling wiped the free-text label as well as the link");
  const afterUnfiling = await siteAsListed(target, ownerToken);
  assert.equal(afterUnfiling?.clientId, null);
  assert.equal(afterUnfiling?.client, canonical);

  // Another company's client id cannot be used to file my site. This is the
  // ONLY check on that path in this mode — there are no foreign keys here.
  const theirs = await newClient(`Cross Filing ${++idSeq}`, outsiderToken);
  const cross = await req("PATCH", `/projects/sites/${target}`, { clientId: theirs }, ownerToken);
  assert.equal(cross.status, 400, "a site was filed under another company's client");
  assert.equal((await siteAsListed(target, ownerToken))?.clientId ?? null, null, "the cross-company filing was refused but stored");

  // CONTROL on that refusal: my own client id still works on the same route.
  const refiled = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId }, ownerToken);
  assert.equal(refiled.status, 200, "the route refuses every clientId, so the 400 above is not a tenancy result");
  assert.equal(refiled.body.site.clientId, clientId);
});

test("deleting a client unfiles its sites and deletes none of them", async () => {
  const clientName = `Doomed Builders ${++idSeq}`;
  const clientId = await newClient(clientName, ownerToken);
  const FILED: string[] = [];
  for (const n of [1, 2, 3]) {
    const id = await newSite(`Doomed Site ${n} ${++idSeq}`, ownerToken);
    await seed("PATCH", `/projects/sites/${id}`, { clientId }, ownerToken);
    FILED.push(id);
  }
  // POSITIVE CONTROL before the delete: they really are filed.
  for (const id of FILED) {
    assert.equal((await siteAsListed(id, ownerToken))?.clientId, clientId, `site ${id} was not filed before the delete`);
  }

  const removed = await req<{ ok: boolean; unfiledSites: number }>("DELETE", `/clients/${clientId}`, undefined, ownerToken);
  assert.equal(removed.status, 200);
  // Measured against what this test actually filed, never a literal.
  assert.equal(removed.body.unfiledSites, FILED.length, "the count of unfiled sites is wrong");

  // The in-memory twin of the cascade assertion: deleting a client must unfile
  // its sites, never delete them. There is no foreign key here to get this
  // right, so this is the only thing checking the hand-written version.
  for (const id of FILED) {
    const row = await siteAsListed(id, ownerToken);
    assert.ok(row, `site ${id} was DELETED by deleting its client`);
    assert.equal(row.clientId, null, `site ${id} still points at a client that no longer exists`);
    assert.equal(row.client, clientName, `site ${id} lost its client's name as well as the link`);
  }
  // And the client itself is gone, so the loop above is not passing because
  // the delete silently did nothing.
  const clients = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
  assert.ok(!clients.body.clients.some((c) => c.id === clientId), "the client was not deleted, so nothing above was measured");
});

test("crew cannot file a site under a client, and a manager can", async () => {
  const clientId = await newClient(`Crew Filing ${++idSeq}`, ownerToken);
  const target = await newSite(`Crew Filing Site ${++idSeq}`, ownerToken);

  const crewAttempt = await req("PATCH", `/projects/sites/${target}`, { clientId }, crewToken);
  assert.equal(crewAttempt.status, 403, "crew filed a site under a client");
  assert.equal((await siteAsListed(target, ownerToken))?.clientId ?? null, null, "a 403 was returned but the site was filed anyway");

  // CONTROL, same endpoint, same test.
  const ownerAttempt = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId }, ownerToken);
  assert.equal(ownerAttempt.status, 200, "the manager cannot file a site either");
  assert.equal((await siteAsListed(target, ownerToken))?.clientId, clientId);

  // And crew retain the capability this workstream must not take away.
  const crewSites = await req<{ sites: Site[] }>("GET", "/projects/sites", undefined, crewToken);
  assert.equal(crewSites.status, 200);
  const seen = crewSites.body.sites.find((s) => s.id === target);
  assert.ok(seen, "crew can no longer see the site they are standing on");
  assert.equal(seen.clientId, clientId, "crew can see the site but not what it is filed under");
});

test("the clients list reports how many sites each client holds", async () => {
  const clientId = await newClient(`Counted Builders ${++idSeq}`, ownerToken);
  const empty = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
  assert.equal(empty.body.clients.find((c) => c.id === clientId)?.siteCount, 0, "a brand new client did not report zero sites");

  const FILED: string[] = [];
  for (const n of [1, 2]) {
    const id = await newSite(`Counted Site ${n} ${++idSeq}`, ownerToken);
    await seed("PATCH", `/projects/sites/${id}`, { clientId }, ownerToken);
    FILED.push(id);
  }
  const counted = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
  // Measured against what was filed, and the OTHER clients must still report
  // their own counts rather than this one's — a count that is really a total
  // would pass the line above.
  assert.equal(counted.body.clients.find((c) => c.id === clientId)?.siteCount, FILED.length);
  const another = await newClient(`Uncounted Builders ${++idSeq}`, ownerToken);
  const both = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
  assert.equal(both.body.clients.find((c) => c.id === another)?.siteCount, 0, "the site count is a company total, not a per-client count");
  assert.equal(both.body.clients.find((c) => c.id === clientId)?.siteCount, FILED.length);
});

test("binning a site takes it out of its client's count, and restoring puts it back", async () => {
  // L114, and the defect the owner reported as "site numbers do not update
  // under client information". `countSitesByClient` counted every row filed
  // under the client, binned or not, in BOTH stores — so the number under a
  // client's name never came down when a site was deleted, and the site list
  // on the same screen disagreed with it because that list does filter the bin.
  //
  // Not a staleness bug: the count is recomputed on every GET /clients. It was
  // computed over the wrong population, which is why no amount of refetching
  // ever fixed it.
  const clientId = await newClient(`Binned Count ${++idSeq}`, ownerToken);
  const FILED: string[] = [];
  for (const n of [1, 2]) {
    const id = await newSite(`Binned Count Site ${n} ${++idSeq}`, ownerToken);
    await seed("PATCH", `/projects/sites/${id}`, { clientId }, ownerToken);
    FILED.push(id);
  }
  const countFor = async (id: string): Promise<number | undefined> => {
    const list = await seed<{ clients: Client[] }>("GET", "/clients", undefined, ownerToken);
    return list.body.clients.find((c) => c.id === id)?.siteCount;
  };

  // POSITIVE CONTROL, before anything is binned: the count is the population
  // this test filed, derived rather than written down (L112).
  assert.equal(await countFor(clientId), FILED.length, "the filed sites were not counted at all");

  const binned = await req("DELETE", `/projects/sites/${FILED[0]}`, undefined, ownerToken);
  assert.equal(binned.status, 200, "the site was not binned, so nothing below is measured");
  // The site really has left the list the user reads on the same screen. This
  // is the half that was always right, and it is here to make the disagreement
  // the subject of the test rather than one number in isolation.
  assert.equal(
    await siteAsListed(FILED[0], ownerToken), undefined,
    "the binned site is still listed, so the count below is not being compared against anything"
  );
  assert.equal(
    await countFor(clientId), FILED.length - 1,
    "the client still counts a binned site — this is the reported bug"
  );

  // POSITIVE CONTROL on the other side: restoring puts it back. A count that
  // had simply been decremented on delete would pass the line above and fail
  // this one, and that is the difference between a counter and a count.
  const restored = await req("POST", `/projects/sites/${FILED[0]}/restore`, undefined, ownerToken);
  assert.equal(restored.status, 200, "the site was not restored, so the count below proves nothing");
  assert.ok(await siteAsListed(FILED[0], ownerToken), "the restored site is not listed again");
  assert.equal(
    await countFor(clientId), FILED.length,
    "the restored site is listed again but is not counted again"
  );

  // And the binned site stays out of the count while it is in the bin even
  // after an unrelated site is filed, so the number is not simply "however many
  // PATCHes this client has seen".
  await seed("DELETE", `/projects/sites/${FILED[1]}`, undefined, ownerToken);
  assert.equal(await countFor(clientId), FILED.length - 1, "binning the second site did not come off the count");
});
