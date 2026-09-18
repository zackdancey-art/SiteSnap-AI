# Vacuous-assertion audit — services/api test suite

**Date:** 2026-09-18 · **Method:** manual mutation testing (execution-counting), not line coverage.

## Why this audit exists

A negative assertion — `length === 0`, `=== null`, `doesNotMatch`, `!includes(...)` — passes
in two very different worlds:

1. the code ran and correctly produced nothing, or
2. the code never ran at all.

Line coverage cannot tell these apart: both light the line up green. The only way to
separate them is to break the behaviour under test and check that a test notices. That is
what was done here — 8 deliberate mutations, each applied to source, compiled, run, and
reverted.

## Scope

51 negative assertions across 19 files. Of these, **11 sit in the 5 DB-gated suites**
(`rls-h1b`, `rls-integration`, `store-roundtrip`, `signature-roundtrip`, `incident-roundtrip`)
which `SKIP` without `TEST_DATABASE_URL` and therefore contribute **zero local execution**.
They are verified in CI only. That is now enforced rather than assumed: `run-tests.sh`
hardcodes `EXPECTED_DB_SUITES=5` and asserts the local skip count is exactly 5, so a suite
that silently stops skipping (and starts passing vacuously in-memory) fails the gate.

## Mutation results

| # | Mutation | Target assertion | Result |
|---|---|---|---|
| M1 | Cascade-delete of entries removed | `integration.test.ts` entries length 0 | **CAUGHT** |
| M2 | `listEntries` access filter removed | matrix entries row | **CAUGHT** |
| M3 | Void-status check dropped | signature void assertions | **CAUGHT** |
| M4 | Malformed-token check bypassed | `authToken.test.ts` | **CAUGHT** |
| M5 | Provenance signature verification bypassed | `diary-provenance.test.ts` | **CAUGHT** (4 tests) |
| M6 | `listSites()` returns `[]` for **everyone** | matrix sites row | **SURVIVED** → fixed |
| M7 | `/uploads/sign` returns `url: null` for **everyone** | matrix signed-URL row | **SURVIVED** → fixed |
| M8 | Boot error message always names Twilio | `server-boot-config.ts:87` `doesNotMatch` | **CAUGHT** (2 tests) |

Six of eight caught. The two that survived share one shape, and it is the shape worth
naming.

## The finding

**A negative assertion needs a positive control on the same endpoint, in the same test.**

Every surviving mutation broke a feature *completely* — for the attacker and the rightful
owner alike — and the isolation tests stayed green, because "B must not see A's data" is
equally satisfied by "nobody sees any data".

- **M6** (`listSites → []`): the whole 14-test isolation matrix passed. The wider suite did
  catch it (5 failures in `integration`, `api-flow.e2e`, `company-rbac`, `invites`), so the
  matrix was being rescued by files it has no relationship with. Delete or skip those and
  the matrix silently stops testing isolation.
- **M7** (`/uploads/sign` denies everyone): **all 126 tests passed.** Nothing anywhere in the
  suite asserted that signing works for the file's owner. The signed-URL feature could have
  been entirely dead and the suite would have reported success. This is the same failure
  mode the audit was commissioned to find, in test form.

M7 is the serious one. M6 is a latent version of it.

## Changes made

1. **10 positive controls added to the isolation matrix** — each list row now also asserts
   that Company A *does* see its own row, so a list endpoint broken to return `[]` fails
   here rather than elsewhere. Re-running M6 against the matrix alone: SURVIVED → **CAUGHT**.
2. **Positive control added for `/uploads/sign`** — Company A must receive a real signed URL
   for its own file before Company B is asserted to receive `null`. Re-running M7:
   SURVIVED → **CAUGHT**.
3. **Precondition guard added** to `integration.test.ts` cascade-delete: the entry is now
   asserted created (201) and *listed* before the delete, so the trailing `length === 0`
   means "the cascade worked", not "nothing was ever there".
4. **19 unchecked seed requests converted to `seed()`** across 5 files. A bare
   `await req(...)` used as setup discards the response; if the seed breaks, every assertion
   downstream tests nothing. `seed()` asserts 2xx and fails at the setup line. All 19 were
   in fact passing — this is a guard against future drift, not a bug fix (suite before and
   after: 126 pass / 0 fail / 5 skip).

## Sound patterns found (no change needed)

These were checked and are correctly constructed — recorded so they are not re-audited:

- `signature-store.test.ts:515/524` — `"base64" in photo === false` is followed by positive
  assertions on the *same object* (`.id`, `.uri`), so a dropped photo array throws.
- `server-boot-config.test.ts:87` — preceded by three `assert.match` calls on the same
  message; the message is proven to exist. Confirmed by M8.
- `ai-runtime-fallback.test.ts:125` — `assert.equal(generation?.model, null)` *is* the risky
  shape (optional chaining + loose equality makes `undefined == null` true), but line 124
  asserts `generation?.generator === "fallback"` first and throws before it can be reached.
  Sound by ordering; fragile if the lines are ever reordered.
- `entry-notes-roundtrip.test.ts:186`, `store-roundtrip.test.ts:199-216` — paired with
  positive assertions on the same object.

## Recommended follow-up (not in this branch)

An ESLint rule banning a bare `await req(...)` expression statement in test files, pointing
at `seed()` — `no-restricted-syntax` with an
`ExpressionStatement > AwaitExpression > CallExpression[callee.name="req"]` selector.

It is deliberately **not** included here. The `feat/eslint-ban-raw-pool-outside-storage`
branch already adds a `no-restricted-syntax` block for the same file scope, and an ESLint
`overrides` block *replaces* a rule's options rather than merging them — landing a second
one on a parallel branch would silently disarm whichever merges first. This rule should be
added on top of that branch once it merges, with both selectors stated in one block.
