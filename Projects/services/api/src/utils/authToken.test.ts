import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthToken, verifyAuthToken } from "./authToken";

test("createAuthToken and verifyAuthToken round trip", () => {
  const token = createAuthToken({
    email: "worker@example.com",
    fullName: "Worker User",
    role: "worker",
    tokenGeneration: 0,
  });

  const claims = verifyAuthToken(token);
  assert.ok(claims);
  assert.equal(claims?.email, "worker@example.com");
  assert.equal(claims?.fullName, "Worker User");
  assert.equal(claims?.role, "worker");
});

test("verifyAuthToken rejects malformed tokens", () => {
  const claims = verifyAuthToken("invalid-token");
  assert.equal(claims, null);
});
