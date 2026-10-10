import { test } from "node:test";
import assert from "node:assert/strict";
import { describeInviteRefusal } from "./invite-refusal";

/**
 * The defect these cover: the invitation refusal was decided by substring match
 * on the server's prose, so the only branch that could ever fire was the wrong
 * one. See the header of lib/invite-refusal.ts.
 */

const wrongUser = (over: Record<string, unknown> = {}) =>
  Object.assign(new Error("This invitation is for her@example.test. You're signed in as him@example.test — sign out, then open the invitation link again to accept it."), {
    status: 403,
    code: "invite_wrong_user",
    body: { invitedEmail: "her@example.test", signedInAs: "him@example.test" },
    ...over,
  });

test("a wrong-recipient refusal names both addresses", () => {
  const r = describeInviteRefusal(wrongUser());
  assert.match(r.message, /her@example\.test/, "the invited address must appear");
  assert.match(r.message, /him@example\.test/, "the signed-in address must appear");
  assert.match(r.message, /sign out/i, "it must say what to do about it");
  assert.equal(r.invitedEmail, "her@example.test");
  assert.equal(r.signedInAs, "him@example.test");
});

test("only a wrong-recipient refusal offers sign-out", () => {
  // The negative half: `invitedEmail` is what app/invite.tsx uses to decide
  // whether to render the Sign out control, so a refusal that is NOT about
  // identity must not carry it. Asserted alongside the positive case on the
  // same function, because "it is null" passes just as happily against a
  // describeInviteRefusal that returns null for everything.
  const notFound = describeInviteRefusal(Object.assign(new Error("Invite not found or has expired."), { status: 404 }));
  assert.equal(notFound.invitedEmail, null);
  assert.equal(notFound.signedInAs, null);

  const serverError = describeInviteRefusal(Object.assign(new Error("Could not accept the invitation."), { status: 500 }));
  assert.equal(serverError.invitedEmail, null);

  assert.equal(describeInviteRefusal(wrongUser()).invitedEmail, "her@example.test", "positive control");
});

test("a 404 is reported as not usable, not as expired", () => {
  // The old screen reached its "expired" wording through `msg.includes("expired")`
  // against the route's single 404 sentence, so an invitation that never
  // existed was reported as one that had run out. The route answers one status
  // and one sentence for not-found, expired and already-used deliberately.
  const r = describeInviteRefusal(Object.assign(new Error("Invite not found or has expired."), { status: 404 }));
  assert.match(r.message, /not valid/i);
  assert.match(r.message, /expired/i, "expiry is still named as one possibility");
  assert.match(r.message, /already been used/i, "so is re-use");
});

test("a refusal always produces a sentence, never silence", () => {
  for (const thrown of [undefined, null, "a string", 42, {}, new Error(""), new Error("   ")]) {
    const r = describeInviteRefusal(thrown);
    assert.ok(r.message.trim().length > 0, `empty message for ${JSON.stringify(thrown)}`);
  }
  // Positive control: when the server did supply words, they are the ones used,
  // rather than being replaced by the generic sentence above.
  const r = describeInviteRefusal(Object.assign(new Error("You are already a member of a different company."), { status: 409 }));
  assert.equal(r.message, "You are already a member of a different company.");
});

test("a wrong-recipient refusal from an older API still says what to do", () => {
  // A newer bundle can reach an API that has not deployed the two fields yet.
  const r = describeInviteRefusal(Object.assign(new Error(""), { status: 403, code: "invite_wrong_user" }));
  assert.match(r.message, /different email address/i);
  assert.match(r.message, /sign out/i);
  assert.equal(r.invitedEmail, null, "no addresses to show, so no sign-out affordance");
});
