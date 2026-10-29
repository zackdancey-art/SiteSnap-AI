/**
 * The in-memory half of L105: a refused signup leaves no company behind.
 *
 * WHY THIS FILE EXISTS ALONGSIDE A DB-GATED ONE
 * `signup-company-transaction-db.test.ts` is the suite the standing rule asks
 * for -- this touches data, so it belongs against real Postgres -- and it is
 * the only one that can prove a `BEGIN`/`ROLLBACK` discards the row.
 *
 * It cannot prove the OTHER implementation. The in-memory store has no
 * transactions, so `createCompanyWithOwner` compensates there by restoring the
 * company Map by hand. That is a second mechanism, written for this fix, and a
 * Postgres-only suite would never execute a line of it. It is also the half
 * that every developer and every CI run without a database actually exercises,
 * because `useDatabase()` is false and these routes answer from the Maps.
 *
 * So: the DB suite covers the transaction, and this covers the compensation.
 * Neither is a substitute for the other, and the defect they describe is the
 * same one -- `test-phone-exemption.test.ts` already establishes that the
 * second signup on one phone number is genuinely refused in this harness, so
 * the precondition here is reachable rather than assumed.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { getCompany, findUserByEmail, resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { soloCompanyIdForEmail } from "../utils/authToken";

let server: http.Server;
let baseUrl: string;

const PASSWORD = "Password123!!";

type Answer = { status: number; body: Record<string, unknown> };

const post = async (route: string, body: unknown): Promise<Answer> => {
  const res = await fetch(`${baseUrl}/api${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: text }; }
  return { status: res.status, body: parsed };
};

/**
 * The whole three-stage signup. Stages 1 and 2 are asserted because a helper
 * that silently stopped working at stage 2 would turn every assertion below it
 * into a test of nothing; stage 3's status is returned rather than asserted,
 * because it is the thing under test.
 */
const register = async (email: string, phone: string, companyName?: string): Promise<Answer> => {
  const initiate = await post("/auth/register/initiate", {
    email,
    password: PASSWORD,
    phone,
    fullName: "Orphan Tester",
    ...(companyName ? { companyName } : {}),
  });
  assert.equal(initiate.status, 200, `stage 1 failed: ${JSON.stringify(initiate.body)}`);
  const emailCode = (initiate.body.devCodes as { emailCode?: string } | undefined)?.emailCode;
  assert.ok(emailCode, `stage 1 returned no dev email code: ${JSON.stringify(initiate.body)}`);

  const verifyEmail = await post("/auth/register/verify-email", { email, emailCode });
  assert.equal(verifyEmail.status, 200, `stage 2 failed: ${JSON.stringify(verifyEmail.body)}`);
  const smsCode = (verifyEmail.body.devCodes as { smsCode?: string } | undefined)?.smsCode;
  assert.ok(smsCode, `stage 2 returned no dev sms code: ${JSON.stringify(verifyEmail.body)}`);

  return post("/auth/register/verify", { email, smsCode });
};

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
  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  await resetRateLimitStoreForTests();
  // ASSIGN, never delete: server.ts calls dotenv.config() on import, and dotenv
  // repopulates an absent key while leaving an empty one alone. An inherited
  // TEST_PHONE_NUMBERS would exempt the collision this file depends on.
  process.env.TEST_PHONE_NUMBERS = "";
});

test("a signup refused on the phone collision leaves no company in the store", async () => {
  const phone = "+64211234501";
  const winner = "orphan-winner@example.test";
  const loser = "orphan-loser@example.test";

  const first = await register(winner, phone, "Winner Contracting");
  assert.equal(first.status, 201, `the first signup should succeed: ${JSON.stringify(first.body)}`);

  const second = await register(loser, phone, "Loser Contracting");
  assert.equal(second.status, 409, `the second signup should be refused: ${JSON.stringify(second.body)}`);

  // THE DEFECT. Before this branch the route created the company and then the
  // user as two separate calls, so the refused signup's company was already in
  // the Map and nothing ever removed it.
  assert.equal(
    await getCompany(soloCompanyIdForEmail(loser)),
    null,
    "the refused signup left a company behind -- createCompanyWithOwner did not compensate"
  );
  assert.equal(await findUserByEmail(loser), null, "the refused signup left a user behind");

  // BOTH CONTROLS, SAME ENDPOINT, SAME TEST. A getCompany that answered null to
  // everything, or a compensation that deleted the wrong row, would pass the
  // two assertions above having proved nothing.
  const winnerCompany = await getCompany(soloCompanyIdForEmail(winner));
  assert.ok(
    winnerCompany,
    "the accepted signup has no company -- the control failed, so the negatives above prove nothing"
  );
  assert.equal(winnerCompany.ownerEmail, winner);
  assert.equal(winnerCompany.name, "Winner Contracting");
  const winnerUser = await findUserByEmail(winner);
  assert.ok(winnerUser, "the accepted signup has no user");
  assert.equal(winnerUser.companyId, soloCompanyIdForEmail(winner));
});

test("the compensation removes only the row the failed signup added", async () => {
  // The upsert case, and the reason the rollback restores a captured value
  // rather than deleting unconditionally. `createCompany` is
  // `ON CONFLICT (id) DO UPDATE`, so a second signup for an address that
  // already owns a company must not be able to delete the company it found.
  //
  // Reached here by signing the owner up, then having them sign up again from
  // the same address on a colliding number. Stage 1 refuses a duplicate email
  // with a 409 before any store write, so the second attempt never reaches the
  // company code -- which is itself worth pinning, because it is the reason
  // the unconditional delete would have been unreachable rather than harmless.
  const phone = "+64211234502";
  const other = "+64211234503";
  const owner = "orphan-owner@example.test";

  assert.equal((await register(owner, phone, "Owner Contracting")).status, 201);

  const again = await post("/auth/register/initiate", {
    email: owner,
    password: PASSWORD,
    phone: other,
    fullName: "Orphan Tester",
  });
  assert.equal(again.status, 409, `a duplicate email should be refused at stage 1: ${JSON.stringify(again.body)}`);

  // The company survived, with the name and owner it was created with.
  const company = await getCompany(soloCompanyIdForEmail(owner));
  assert.ok(company, "the existing company was removed by a signup that never created one");
  assert.equal(company.name, "Owner Contracting");
  assert.equal(company.ownerEmail, owner);

  // The control, on the same store call: an address that never signed up has
  // no company. Without it, a getCompany that returned a record for any id
  // would pass the assertion above.
  assert.equal(await getCompany(soloCompanyIdForEmail("nobody@example.test")), null);
});
