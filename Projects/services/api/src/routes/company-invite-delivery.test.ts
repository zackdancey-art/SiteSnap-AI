/**
 * The company invitation: that it is actually sent, and that the sender is told
 * which of three things happened.
 *
 * `POST /company/members/invite` is the route both the manager portal's Team
 * page and the mobile invite screen call, and it did not send an email. It
 * created the row, put the raw bearer token in its own JSON response, and
 * returned 201 "sent". Nothing was dispatched, to anybody, ever — so "I invite
 * someone and nothing arrives" needed no further explanation, and no amount of
 * fixing the acceptance path downstream would have produced a single joined
 * crew member.
 *
 * Every assertion below that something is absent is paired with the positive
 * case in the same test, and every enumeration asserts its own count, because
 * "the mailer was called" and "the mailer was never reached" both produce an
 * empty mailbox and a green test.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests, expireCompanyInvitesForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { getFakeSendsForTests } from "../services/notificationService";

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

async function seed<T = unknown>(...args: Parameters<typeof req>): Promise<{ status: number; body: T }> {
  const res = await req<T>(...args);
  assert.ok(
    res.status >= 200 && res.status < 300,
    `seed request failed: ${args[0]} ${args[1]} -> ${res.status} ${JSON.stringify(res.body)}`
  );
  return res;
}

let _phoneSeq = 0;
function nextPhone() { return `+616${String(++_phoneSeq).padStart(8, "0")}`; }

async function registerUser(email: string, name: string, companyName?: string): Promise<string> {
  const regBody: Record<string, string> = { email, phone: nextPhone(), fullName: name, password: "Password123!!" };
  if (companyName) regBody.companyName = companyName;
  const r1 = await seed<{ devCodes?: { emailCode: string } }>("POST", "/auth/register", regBody);
  const r2 = await seed<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode: r1.body.devCodes!.emailCode }
  );
  const r3 = await req<{ token: string }>(
    "POST", "/auth/register/verify", { email, smsCode: r2.body.devCodes!.smsCode }
  );
  assert.equal(r3.status, 201, `verify ${email} failed: ${JSON.stringify(r3.body)}`);
  return r3.body.token;
}

type InviteResult = {
  email: string;
  status: string;
  delivered?: boolean;
  token?: string;
};

async function invite(ownerToken: string, emails: string[], companyRole = "crew") {
  return req<{ results: InviteResult[] }>(
    "POST", "/company/members/invite", { emails, companyRole }, ownerToken
  );
}

/** Emails the notification layer was asked to send to this address. */
function emailsTo(address: string) {
  return getFakeSendsForTests().filter((s) => s.kind === "email" && s.to === address);
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

test("inviting a company member dispatches an invitation email carrying the token", async () => {
  const ownerToken = await registerUser("owner@inv.test", "Ann Owner", "Kauri Build");

  const before = emailsTo("newcrew@inv.test").length;
  assert.equal(before, 0, "control: nothing has been sent to this address yet");

  const res = await invite(ownerToken, ["newcrew@inv.test"]);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.results.length, 1, `expected exactly 1 result, got ${res.body.results.length}`);

  const sent = emailsTo("newcrew@inv.test");
  assert.equal(
    sent.length, 1,
    `expected exactly 1 email to the invitee, got ${sent.length} — ` +
    "0 means the route still never calls the mailer, which is the bug this test exists for"
  );

  const mail = sent[0];
  assert.equal(mail.kind, "email");
  if (mail.kind !== "email") throw new Error("unreachable");

  // The company name and inviter reach the recipient — a generic email is how
  // an invitation gets mistaken for spam by somebody expecting a site name.
  assert.match(mail.subject, /Kauri Build/, `subject should name the company: ${mail.subject}`);
  assert.match(mail.subject, /Ann Owner/, `subject should name the inviter: ${mail.subject}`);

  // And it carries the actual token, not a placeholder. Without this the email
  // could be sent, be asserted on, and still be unusable.
  const token = res.body.results[0].token;
  assert.ok(token, "test mode returns the token because delivery is faked as failed");
  assert.ok(
    mail.text.includes(`?token=${token}`),
    "the email body must carry the invitation's own token as a ?token= link"
  );
  assert.ok(mail.html.includes(`?token=${token}`), "the HTML body must carry the same link");
});

test("a second invitation to the same address re-sends rather than erroring", async () => {
  const ownerToken = await registerUser("owner2@inv.test", "Owner", "Kauri Build");

  const first = await invite(ownerToken, ["dup@inv.test"]);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.results.length, 1);
  assert.equal(first.body.results[0].status, "sent", "the first invitation is a send");

  const second = await invite(ownerToken, ["dup@inv.test"]);
  assert.equal(second.status, 201, `re-inviting must not error: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.results.length, 1);
  assert.equal(
    second.body.results[0].status, "resent",
    "a second invitation to a pending address must report `resent`, not `sent`"
  );

  // Both attempts actually dispatched — a "resent" status that sends nothing
  // would be the same bug wearing a better label.
  assert.equal(
    emailsTo("dup@inv.test").length, 2,
    "both the send and the re-send must dispatch an email"
  );

  // REISSUE, not reuse: the second token differs, so a link already sitting in
  // the invitee's inbox stops working. Pinned deliberately — see the review.
  const firstToken = first.body.results[0].token;
  const secondToken = second.body.results[0].token;
  assert.ok(firstToken && secondToken);
  assert.notEqual(firstToken, secondToken, "re-sending reissues the token rather than reusing it");
});

test("a lapsed invitation can be re-issued, and stays visible to its sender meanwhile", async () => {
  const ownerToken = await registerUser("owner3@inv.test", "Owner", "Kauri Build");
  await seed("POST", "/company/members/invite", { emails: ["lapsed@inv.test"], companyRole: "crew" }, ownerToken);

  const aged = await expireCompanyInvitesForTests("lapsed@inv.test");
  assert.equal(aged, 1, `the helper must have found exactly 1 invitation to age, found ${aged}`);

  // Visible, and labelled. listSiteInvites filters expired rows out, which
  // makes a lapsed invitation indistinguishable from never having sent one.
  const listed = await req<{ invites: Array<{ invitedEmail: string; state: string; token?: string }> }>(
    "GET", "/company/invites", undefined, ownerToken
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const rows = listed.body.invites.filter((i) => i.invitedEmail === "lapsed@inv.test");
  assert.equal(rows.length, 1, `expected exactly 1 listed invitation, got ${rows.length}`);
  assert.equal(rows[0].state, "expired", "an aged invitation must be listed as expired, not hidden");

  // The listing must not hand out the bearer token.
  assert.equal(
    rows[0].token, undefined,
    "the invitation listing must not include the token — it grants company membership"
  );

  // Re-issuable: the lapsed row is revived rather than blocking the re-invite.
  const again = await invite(ownerToken, ["lapsed@inv.test"]);
  assert.equal(again.status, 201, `re-issuing a lapsed invitation must succeed: ${JSON.stringify(again.body)}`);
  assert.equal(again.body.results[0].status, "resent");

  const after = await req<{ invites: Array<{ invitedEmail: string; state: string }> }>(
    "GET", "/company/invites", undefined, ownerToken
  );
  const revived = after.body.invites.filter((i) => i.invitedEmail === "lapsed@inv.test");
  assert.equal(revived.length, 1, `re-issuing must revive the row, not add a second: got ${revived.length}`);
  assert.equal(revived[0].state, "pending", "the revived invitation must be pending again");
});

test("inviting somebody who is already in the company is a status, not an error", async () => {
  const ownerToken = await registerUser("owner4@inv.test", "Owner", "Kauri Build");

  // Get a real member in: invite, register, accept.
  const first = await invite(ownerToken, ["member@inv.test"]);
  assert.equal(first.status, 201);
  const inviteToken = first.body.results[0].token;
  assert.ok(inviteToken);
  const memberToken = await registerUser("member@inv.test", "Mem Ber");
  const accepted = await req<{ companyId?: string }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, memberToken
  );
  assert.equal(accepted.status, 200, `accept failed: ${JSON.stringify(accepted.body)}`);
  assert.ok(accepted.body.companyId, "control: the member really did join a company");

  const mailsBefore = emailsTo("member@inv.test").length;

  const again = await invite(ownerToken, ["member@inv.test"]);
  assert.equal(
    again.status, 201,
    `inviting an existing member must not be an error response: ${again.status} ${JSON.stringify(again.body)}`
  );
  assert.equal(again.body.results.length, 1);
  assert.equal(
    again.body.results[0].status, "already_member",
    `expected already_member, got ${JSON.stringify(again.body.results[0])}`
  );
  assert.equal(
    again.body.results[0].token, undefined,
    "no token should be minted for somebody who is already a member"
  );

  // Nothing was dispatched, and nothing was created.
  assert.equal(
    emailsTo("member@inv.test").length, mailsBefore,
    "an already-member result must not send another invitation email"
  );

  // POSITIVE CONTROL in the same test: the route is still working and still
  // sends for a genuine new address. Without this, `already_member` for
  // everybody would pass every assertion above.
  const fresh = await invite(ownerToken, ["brandnew@inv.test"]);
  assert.equal(fresh.body.results[0].status, "sent", "control: a new address must still be invited");
  assert.equal(
    emailsTo("brandnew@inv.test").length, 1,
    "control: a new address must still receive exactly 1 email"
  );
});

test("a manager can see pending invitations; a viewer cannot", async () => {
  const ownerToken = await registerUser("owner5@inv.test", "Owner", "Kauri Build");

  // Positive control first: the owner can read the listing at all.
  await seed("POST", "/company/members/invite", { emails: ["pending@inv.test"], companyRole: "crew" }, ownerToken);
  const asOwner = await req<{ invites: unknown[] }>("GET", "/company/invites", undefined, ownerToken);
  assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));
  assert.equal(asOwner.body.invites.length, 1, `owner should see exactly 1 invitation, saw ${asOwner.body.invites.length}`);

  // A viewer is below the manager gate.
  const viewerInvite = await invite(ownerToken, ["viewer@inv.test"], "viewer");
  const viewerJoinToken = viewerInvite.body.results[0].token;
  assert.ok(viewerJoinToken);
  const viewerRaw = await registerUser("viewer@inv.test", "View Er");
  const viewerAccept = await req<{ token?: string; companyRole?: string }>(
    "POST", "/projects/invites/accept", { token: viewerJoinToken }, viewerRaw
  );
  assert.equal(viewerAccept.status, 200, JSON.stringify(viewerAccept.body));
  assert.equal(viewerAccept.body.companyRole, "viewer", "control: the account really is a viewer");
  const viewerToken = viewerAccept.body.token!;

  const asViewer = await req("GET", "/company/invites", undefined, viewerToken);
  assert.equal(asViewer.status, 403, "a viewer must not see the company's pending invitations");

  // And the same viewer token still works on something it IS entitled to, so
  // the 403 above is the gate and not a dead token.
  const profile = await req("GET", "/company/profile", undefined, viewerToken);
  assert.equal(profile.status, 200, "control: the viewer token is live and authorised elsewhere");
});
