import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_EXPIRED_MESSAGE,
  SessionExpiredError,
  clearSessionExpired,
  isSessionExpired,
  isSessionExpiredNoticeRaised,
  isSessionErrorCode,
  notifySessionExpired,
  resetSessionForTests,
  setSessionExpiredHandler,
} from "./session";

/**
 * The behaviour under test is "twenty-one simultaneous 401s produce one trip to
 * the sign-in screen, and the next real expiry still produces one". That is a
 * latch, and a latch is exactly the kind of thing that passes a hand test on a
 * device once and regresses silently, because the second case needs a second
 * session to observe.
 */

beforeEach(() => {
  resetSessionForTests();
});

test("a 401 routes to sign-in with the session message, not a feature error", () => {
  const seen: string[] = [];
  setSessionExpiredHandler(() => seen.push("routed"));

  assert.equal(notifySessionExpired(), true);

  assert.deepEqual(seen, ["routed"]);
  assert.equal(new SessionExpiredError().message, SESSION_EXPIRED_MESSAGE);
});

test("twenty-one concurrent 401s route to sign-in exactly once", () => {
  // The number is not arbitrary. SITESNAP-MOBILE-1 captured twenty-one media
  // signing requests failing together on one deploy; that is the real fan-out.
  let routes = 0;
  setSessionExpiredHandler(() => { routes += 1; });

  const raisedBy = Array.from({ length: 21 }, () => notifySessionExpired());

  assert.equal(routes, 1, "twenty-one 401s must not produce twenty-one navigations");
  assert.equal(raisedBy.filter(Boolean).length, 1, "exactly one caller is told it raised the notice");
  assert.equal(raisedBy[0], true, "and it is the first one");
});

test("a later expiry is reported again once a session has begun", () => {
  // The positive control for the latch. Without clearSessionExpired the first
  // test above would also pass on a module that notifies once and never again,
  // which would leave the second week of use silently back at the old defect.
  let routes = 0;
  setSessionExpiredHandler(() => { routes += 1; });

  notifySessionExpired();
  assert.equal(routes, 1);

  notifySessionExpired();
  assert.equal(routes, 1, "still latched");

  clearSessionExpired();
  notifySessionExpired();
  assert.equal(routes, 2, "a fresh session makes a fresh 401 news again");
});

test("the notice reports whether it currently stands", () => {
  assert.equal(isSessionExpiredNoticeRaised(), false);
  notifySessionExpired();
  assert.equal(isSessionExpiredNoticeRaised(), true);
  clearSessionExpired();
  assert.equal(isSessionExpiredNoticeRaised(), false);
});

test("a handler that throws does not surface at the call site that reported the 401", () => {
  // If this leaked, the throw would arrive inside whichever feature happened to
  // make the failing request and be shown as that feature's error - the precise
  // defect. The latch must still have been set.
  setSessionExpiredHandler(() => { throw new Error("navigation blew up"); });

  assert.doesNotThrow(() => notifySessionExpired());
  assert.equal(isSessionExpiredNoticeRaised(), true);
});

test("with no handler registered the notice still latches", () => {
  // Startup ordering: a 401 can land before the auth provider has mounted.
  // Losing the latch there would mean the next 401 navigates twice.
  assert.equal(notifySessionExpired(), true);
  assert.equal(notifySessionExpired(), false);
});

test("setting a handler returns the previous one so a remount can restore it", () => {
  const first = () => {};
  const second = () => {};
  assert.equal(setSessionExpiredHandler(first), null);
  assert.equal(setSessionExpiredHandler(second), first);
});

test("a session-expiry error is recognised across module and class boundaries", () => {
  assert.equal(isSessionExpired(new SessionExpiredError()), true);

  // The pre-existing helper in lib/data-context.tsx throws a plain Error with
  // `status` attached. It must be recognised too, or that call site keeps
  // showing its own wording for a 401.
  const legacy = Object.assign(new Error("Unauthorized"), { status: 401 });
  assert.equal(isSessionExpired(legacy), true);
});

test("a feature failure is not mistaken for an expired session", () => {
  // The positive control for isSessionExpired. A module that returned true for
  // everything would pass the test above and would send someone to the sign-in
  // screen because a delivery failed validation.
  assert.equal(isSessionExpired(Object.assign(new Error("Conflict"), { status: 409 })), false);
  assert.equal(isSessionExpired(Object.assign(new Error("Forbidden"), { status: 403 })), false);
  assert.equal(isSessionExpired(new Error("Network request failed")), false);
  assert.equal(isSessionExpired(null), false);
  assert.equal(isSessionExpired(undefined), false);
  assert.equal(isSessionExpired("401"), false);
});

test("a 401 about a credential in the request body is not an expired session", () => {
  // The defect this prevents is the mirror image of the one the module exists
  // for. POST /api/auth/change-password answers 401 with
  // code "invalid_credentials" when the CURRENT password is wrong. The session
  // is live; the typo is in the body. Reading that as an expiry would sign the
  // person out of the app, clear their token and route them to sign-in, for
  // mistyping a password - and the screen that could have said "that is not
  // your current password" would say nothing at all.
  const wrongPassword = Object.assign(new Error("Current password is incorrect."), {
    status: 401,
    code: "invalid_credentials",
  });
  assert.equal(isSessionExpired(wrongPassword), false);

  const wrongCode = Object.assign(new Error("Verification code is incorrect."), {
    status: 401,
    code: "invalid_verification_code",
  });
  assert.equal(isSessionExpired(wrongCode), false);

  // The positive control, on the same function with the same status: the codes
  // that DO mean the session must still route. A discriminator that answered
  // false for everything would pass the two assertions above and restore the
  // original defect in full.
  const expired = Object.assign(new Error("Your session has expired."), {
    status: 401,
    code: "session_expired",
  });
  assert.equal(isSessionExpired(expired), true);

  const noCredential = Object.assign(new Error("Missing bearer token."), {
    status: 401,
    code: "no_credential",
  });
  assert.equal(isSessionExpired(noCredential), true);
});

test("a 401 with no code still reads as an expired session", () => {
  // Deliberate, and the reason is release ordering: an `eas update` can land on
  // a phone before the API deploy that introduced the codes, and every 401 this
  // API returned before them was session-shaped. Fail towards sign-in - one
  // unnecessary sign-in against a silent failure on a compliance record.
  assert.equal(isSessionErrorCode(undefined), true);
  assert.equal(isSessionErrorCode(null), true);
  assert.equal(isSessionErrorCode(""), true);
  assert.equal(isSessionErrorCode(42), true);
  assert.equal(isSessionExpired(Object.assign(new Error("Unauthorized"), { status: 401 })), true);

  // Positive control: a code that is present and is not a session code is
  // still refused, so the fallback above is a fallback and not a blanket yes.
  assert.equal(isSessionErrorCode("invalid_credentials"), false);
});
