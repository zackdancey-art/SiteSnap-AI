import * as ts from "typescript";

/**
 * The rule that a 403 must not sign anybody out, as a thing a machine checks.
 *
 * THE RULE
 *
 * Only a 401 may route to the sign-in screen. Every call to
 * `notifySessionExpired()` — the one function that raises the sign-out notice —
 * and every `new SessionExpiredError()` must sit under a condition that tests
 * the response status for 401, and under no condition that tests it for
 * anything else.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION, AND WHY NOW
 *
 * AUDIT L73 was seven screens each inventing their own wording for a dead
 * session, closed by routing every session-shaped 401 through lib/session.ts
 * from one place. That consolidation put a sign-out one line away from eight
 * response-status branches.
 *
 * The crew-permissions work generates authorisation failures ON PURPOSE: a crew
 * member who reaches a manager-only route gets a 403, which means "you are who
 * you say you are and you may not do this" — the opposite of a dead session.
 * 401 and 403 are adjacent integers, `>= 400` reads as a natural generalisation
 * of `=== 401` to anyone tidying up, and the symptom of getting it wrong is a
 * crew member signed out every time they touch a manager-only screen: a worse
 * bug than the one that phase fixes, on a code path nobody will test by hand
 * because signing in again makes it go away.
 *
 * Unit-testing `isSessionExpired()` proves the predicate discriminates. It
 * cannot prove that the eight places which call the notifier agree with it, and
 * those are where the defect would live.
 *
 * WHAT IT REFUSES TO GUESS
 *
 * A guard this cannot read as a status comparison is a VIOLATION, not a pass.
 * A call reached through a helper, a variable holding the status, a `switch`, or
 * the `else` branch of a 401 test all come out as unguarded. That is deliberate
 * and it fails closed: the cost is a developer having to make a guard legible,
 * and the alternative is a check that resolves "I don't understand this" to
 * "fine", which is how a check like this becomes decoration (see
 * lib/screen-header-audit.ts, which takes the same line, and
 * docs/VACUITY-AUDIT.md for what the other choice has cost here).
 *
 * As with the header audit, everything takes a plain map of path -> source, so
 * the test can run it against the real tree and against synthetic fixtures in
 * the same breath. The fixtures are the positive control: they are the only way
 * to show that a 403 routed to sign-in WOULD be caught, given that the real
 * tree is — correctly — free of one.
 */

/** Paths relative to the package root -> file contents. */
export type VirtualFiles = Record<string, string>;

/**
 * The two ways the app routes to sign-in.
 *
 * `notifySessionExpired` raises the notice the root layout navigates on.
 * `SessionExpiredError` is thrown alongside it so call sites can `return`
 * without describing the failure in their own words; it is included because a
 * throw on a 403 would silently swallow the refusal, leaving the blank screen
 * the message half of this work exists to remove.
 */
export const SIGN_IN_ROUTERS = ["notifySessionExpired", "SessionExpiredError"] as const;

export type CallKind = "notify" | "throw";

export type CallSite = {
  /** Path as given in the VirtualFiles map. */
  file: string;
  /** 1-based, for a clickable reference in a failure message. */
  line: number;
  kind: CallKind;
  /** The enclosing conditions, outermost first, as written. */
  guards: string[];
  /** Status literals compared with === or !== anywhere in those guards. */
  statuses: number[];
};

export type Violation = {
  file: string;
  line: number;
  kind: CallKind;
  rule: "sign-out-needs-a-401-guard" | "sign-out-must-not-be-reached-on-another-status";
  detail: string;
};

export type Audit = {
  files: string[];
  callSites: CallSite[];
  violations: Violation[];
};

/**
 * Status literals compared with `===` or `!==` inside one guard expression.
 *
 * Only strict equality counts. `res.status >= 400` yields nothing, so a call
 * under it is reported as unguarded rather than credited with the 400 it
 * mentions — which is the generalisation this audit exists to catch.
 */
function statusComparisons(node: ts.Node): number[] {
  const found: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        for (const side of [n.left, n.right]) {
          if (ts.isNumericLiteral(side)) {
            const value = Number(side.text);
            // Only HTTP statuses. A `=== 0` or `=== 1` elsewhere in the same
            // condition is not a status test and must not read as one.
            if (value >= 100 && value <= 599) found.push(value);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * The conditions a node is reached under, outermost first.
 *
 * Counted: the condition of an `if` whose THEN branch contains the node, and
 * the left-hand side of a `&&` whose right-hand side contains it. Not counted:
 * the condition of an `if` reached through its ELSE branch, where a `=== 401`
 * test means the status is anything BUT 401 — exactly inverted, so crediting it
 * would turn the one shape that is certainly wrong into a pass.
 */
function guardChain(node: ts.Node): ts.Node[] {
  const chain: ts.Node[] = [];
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child) {
      chain.push(parent.expression);
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child
    ) {
      chain.push(parent.left);
    } else if (ts.isConditionalExpression(parent) && parent.whenTrue === child) {
      chain.push(parent.condition);
    }
    child = parent;
    parent = parent.parent;
  }
  return chain.reverse();
}

/** Which of the two routers a node is, if either. */
function routerKind(node: ts.Node): CallKind | null {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text === "notifySessionExpired" ? "notify" : null;
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
    return node.expression.text === "SessionExpiredError" ? "throw" : null;
  }
  return null;
}

/**
 * Audit the given sources.
 *
 * `lib/session.ts` itself is excluded by the caller, not here: it DEFINES the
 * notifier and the error, and its own tests construct both deliberately. The
 * test states that exclusion where a reader can see it.
 */
export function auditSessionRouting(files: VirtualFiles): Audit {
  const callSites: CallSite[] = [];
  const violations: Violation[] = [];

  for (const file of Object.keys(files).sort()) {
    const source = ts.createSourceFile(
      file,
      files[file],
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const visit = (node: ts.Node): void => {
      const kind = routerKind(node);
      if (kind) {
        const guards = guardChain(node);
        const statuses = [...new Set(guards.flatMap(statusComparisons))].sort((a, b) => a - b);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const site: CallSite = {
          file,
          line,
          kind,
          guards: guards.map((g) => g.getText(source).replace(/\s+/g, " ")),
          statuses,
        };
        callSites.push(site);

        const others = statuses.filter((s) => s !== 401);
        if (others.length > 0) {
          violations.push({
            file,
            line,
            kind,
            rule: "sign-out-must-not-be-reached-on-another-status",
            detail:
              `routes to sign-in under a test for ${others.join(", ")}. A 403 is not a dead ` +
              `session: the person is who they say they are and may not do this. Report it ` +
              `with FORBIDDEN_MESSAGE (lib/permissions.ts) instead.`,
          });
        } else if (!statuses.includes(401)) {
          violations.push({
            file,
            line,
            kind,
            rule: "sign-out-needs-a-401-guard",
            detail:
              `routes to sign-in with no readable \`=== 401\` in its guards ` +
              `[${site.guards.join(" && ") || "none"}]. Only a 401 may sign somebody out; ` +
              `write the status test inline so this check can read it.`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return { files: Object.keys(files).sort(), callSites, violations };
}
