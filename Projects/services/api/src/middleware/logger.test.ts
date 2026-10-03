/**
 * Tests for the request-log URL redaction.
 *
 * `morgan :url` wrote member emails, device push tokens and signed-media
 * credentials into Render's persistent logs on every request. Those logs sit
 * outside the database's tenant isolation and nothing in the product deletes
 * them, so they are the one copy of customer personal data that survives
 * everything else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { redactUrl } from "./logger";

test("redactUrl: removes emails, push tokens and signed-media credentials", () => {
  // The positive control. Every assertion below is "X is absent", and absence
  // passes just as well against a function that returns "" for everything, or
  // that throws and is caught upstream. These prove it still returns a usable
  // URL first.
  assert.equal(redactUrl("/api/projects/sites/site_123"), "/api/projects/sites/site_123");
  assert.equal(
    redactUrl("/api/crew/timecards?siteId=site_123"),
    "/api/crew/timecards?siteId=site_123",
    "an ordinary query parameter must survive — the log is for tracing requests"
  );

  // A member email in a path segment.
  const memberRole = redactUrl("/api/company/members/alice@example.com/role");
  assert.doesNotMatch(memberRole, /alice@example\.com/);
  assert.equal(memberRole, "/api/company/members/[redacted]/role");

  // URL-encoded, which is how a client actually sends it.
  const encoded = redactUrl("/api/company/members/alice%40example.com");
  assert.doesNotMatch(encoded, /alice/);

  // A site member, one level deeper — the id is kept, the email is not.
  const siteMember = redactUrl("/api/projects/sites/site_123/members/bob@example.com");
  assert.doesNotMatch(siteMember, /bob@example\.com/);
  assert.match(siteMember, /site_123/, "the site id is not a credential and stays");

  // A device push token in a path segment.
  const pushToken = redactUrl("/api/push/tokens/ExponentPushToken%5Babcdef123456%5D");
  assert.doesNotMatch(pushToken, /abcdef123456/);

  // Signed-media credentials. `sig` is a bearer grant for a photograph.
  const signed = redactUrl("/api/uploads/media/u_9?sig=deadbeefcafe&exp=1790000000");
  assert.doesNotMatch(signed, /deadbeefcafe/);
  assert.doesNotMatch(signed, /1790000000/);
  assert.match(signed, /sig=\[redacted\]/, "the key stays so the request shape is still readable");
  assert.match(signed, /u_9/, "the upload id stays");

  // An invitation token, if one ever reaches a query string.
  assert.doesNotMatch(redactUrl("/api/invites/accept?token=0123456789abcdef"), /0123456789abcdef/);
});
