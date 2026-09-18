// Pure unit test — no app import, no server, no store. `readIntEnv` reads
// process.env at call time, so each case sets and restores its own key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readIntEnv } from "./env";

const KEY = "READ_INT_ENV_TEST_VALUE";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[KEY] = prev;
    else delete process.env[KEY];
  }
}

// ── the bug this function exists for ────────────────────────────────────────
// `Number(process.env.X ?? 600000)` returns 0 for an empty X, because `??` only
// falls back on null/undefined and "" is neither. Every caller of that idiom
// silently got 0 — for a TTL, that means "already expired".
test("an empty value falls back to the default, not to 0", () => {
  withEnv("", () => {
    assert.equal(readIntEnv(KEY, 600_000), 600_000);
    // The precise shape of the old bug, asserted directly so the regression is
    // named rather than implied.
    assert.notEqual(readIntEnv(KEY, 600_000), 0);
  });
});

test("whitespace is treated as empty, not as garbage", () => {
  withEnv("   ", () => assert.equal(readIntEnv(KEY, 42), 42));
});

test("an absent value falls back to the default", () => {
  withEnv(undefined, () => assert.equal(readIntEnv(KEY, 42), 42));
});

test("a valid integer is used, and surrounding whitespace is tolerated", () => {
  withEnv("900", () => assert.equal(readIntEnv(KEY, 42), 900));
  withEnv(" 900 ", () => assert.equal(readIntEnv(KEY, 42), 900));
  withEnv("0", () => assert.equal(readIntEnv(KEY, 42, { min: 0 }), 0));
});

// ── misconfiguration must be loud ───────────────────────────────────────────
// Number("abc") is NaN, and every comparison against NaN is false. A typo'd TTL
// therefore does not shorten the expiry window — it removes expiry entirely.
// That has to fail at boot, not silently disable a security control.
test("a non-numeric value throws rather than becoming NaN", () => {
  withEnv("abc", () => {
    assert.throws(() => readIntEnv(KEY, 42), /must be an integer/);
  });
});

test("a non-integer numeric value throws", () => {
  withEnv("12.5", () => assert.throws(() => readIntEnv(KEY, 42), /must be an integer/));
});

test("a value below the minimum throws", () => {
  withEnv("-1", () => assert.throws(() => readIntEnv(KEY, 42, { min: 0 }), /must be >= 0/));
  withEnv("0", () => assert.throws(() => readIntEnv(KEY, 42, { min: 1 }), /must be >= 1/));
});

test("the error names the variable and the default, and carries the caller's hint", () => {
  withEnv("nope", () => {
    assert.throws(
      () => readIntEnv(KEY, 7, { hint: "See the comment above." }),
      (err: Error) => {
        assert.match(err.message, new RegExp(KEY));
        assert.match(err.message, /default of 7/);
        assert.match(err.message, /See the comment above\./);
        return true;
      }
    );
  });
});
