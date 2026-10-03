/**
 * Dev-only navigation probe. NOT part of the product.
 *
 * Why this exists
 * ---------------
 * The back chevron on six pushed screens is reported as doing nothing when
 * tapped: `export-diaries`, `backup-data`, `privacy-policy`,
 * `terms-of-service`, `help-support`, `supervisor-dashboard`. These are the
 * app's "Pattern A" screens — registered with `headerShown: true` and no body
 * header, so the chevron is the native UINavigationBar back button drawn by
 * @react-navigation/native-stack, configured only by the root `screenOptions`.
 * Everything else in the app is "Pattern B": `headerShown: false` plus
 * ScreenHeader -> BackButton -> `goBackSafe()`. The two share no code, so a fix
 * proven on one says nothing about the other.
 *
 * Reading the code eliminated every candidate it could (docs/STAGE-0-ANALYSIS.md
 * item 2 carries the evidence for each): no duplicate route registration, no
 * `headerLeft` or `headerBackVisible` override anywhere, no `beforeRemove` /
 * `preventRemove` / `gestureEnabled` guard anywhere in the mobile app, and no
 * JS view capturing the touch — on these screens the header is outside the JS
 * view tree entirely.
 *
 * What reading cannot answer is whether the press reaches JavaScript at all,
 * and that single bit halves the hypothesis space:
 *
 *   no action dispatched        the press never reaches JS. Native hit-test,
 *                              appearance, or something in the header itself.
 *   action dispatched, noop     it reached a navigator that refused it — wrong
 *                              navigator, or no history there.
 *   action dispatched, applied,
 *     stack unchanged after     the pop happened and something re-pushed.
 *
 * WHICH ACTION TO LOOK FOR — this is not GO_BACK, and the distinction is the
 * whole reason this probe logs every action type rather than filtering.
 *
 * A native chevron press dispatches `POP`. @react-navigation/native-stack
 * 7.14.2 wires the native bar's callback straight to StackActions.pop():
 *
 *   onHeaderBackButtonClicked={() => {
 *     navigation.dispatch({ ...StackActions.pop(), source: route.key,
 *                           target: state.key });
 *   }}
 *                            — views/NativeStackView.native.tsx:597-603
 *
 * `GO_BACK` is what Pattern B produces, because BackButton calls
 * `goBackSafe()` -> `router.back()`. So the two patterns emit two different
 * action types, and watching for GO_BACK on a Pattern-A screen reads as "no
 * action dispatched" even when the press landed perfectly. docs/STAGE-0-ANALYSIS.md
 * item 2 names GO_BACK for both; that is the one place it is wrong, and it
 * would have produced a false negative on the first run.
 *
 * `onDismissed` (the swipe) and `onNativeDismissCancelled` dispatch POP as well,
 * with a dismissCount, which is why the payload is logged too.
 *
 * `__unsafe_action__` carries exactly that: the action object, and `noop` —
 * whether it produced any state change. It fires BEFORE the state change is
 * applied, so pairing it with the `state` event gives before and after, and the
 * log reads as a sequence rather than a snapshot. Both are debug-only APIs; the
 * library says so, which is why they live here and not in product code.
 *
 * HOW THIS FILE STAYS OUT OF PRODUCTION BUNDLES — read before editing
 * -------------------------------------------------------------------
 * The call site in app/_layout.tsx reaches this module through a `require()`
 * placed INSIDE an `if (__DEV__)` block. That is load-bearing and it is not
 * interchangeable with a top-level `import`. Metro does not tree-shake; it
 * bundles every statically imported module whether or not anything reachable
 * calls it. Only the gated `require` keeps the dependency out of the graph.
 * Measured for the signature probe by exporting a production bundle and
 * grepping the Hermes string table — see the header of lib/dev-signature-probe.tsx.
 * If someone "tidies" that require into an import, this file ships to customers.
 */

import type { useNavigationContainerRef } from "expo-router";

// The container ref, named through ReturnType rather than by importing
// NavigationContainerRefWithCurrent from @react-navigation/native: that package
// is a transitive dependency of expo-router, not a direct dependency of this
// app, so naming its types here would couple us to the hoisting layout.
type NavContainerRef = ReturnType<typeof useNavigationContainerRef>;

// The parts of a navigation state this probe reads. Deliberately minimal and
// structural — a nested navigator's state has the same shape.
type ProbeNavRoute = { name: string; state?: ProbeNavState };
type ProbeNavState = {
  index?: number;
  routes?: ProbeNavRoute[];
};

/**
 * The focused path through the (possibly nested) navigator tree, with each
 * level's depth. Depth is the point: "did the pop happen" is answered by a
 * number that changes, not by a route name that may be the same either way.
 */
function describeStack(state: ProbeNavState | undefined): string {
  if (!state?.routes?.length) return "<no state yet>";
  const parts: string[] = [];
  let level: ProbeNavState | undefined = state;
  while (level?.routes?.length) {
    const index: number = typeof level.index === "number" ? level.index : level.routes.length - 1;
    const focused: ProbeNavRoute | undefined = level.routes[index];
    if (!focused) break;
    parts.push(`${focused.name} (${index + 1}/${level.routes.length})`);
    level = focused.state;
  }
  return parts.join(" > ");
}

// `getRootState()` throws before the container has mounted, and this probe
// attaches from an effect that may run first. An unreadable state is a fact to
// log, not a reason to crash the screen we are trying to measure.
function readRootState(ref: NavContainerRef): ProbeNavState | undefined {
  try {
    if (!ref.isReady()) return undefined;
    return ref.getRootState() as ProbeNavState;
  } catch {
    return undefined;
  }
}

function brief(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    return "<unserialisable>";
  }
}

/**
 * Attach the probe to the root navigation container. Returns a detach function.
 *
 * Every line is prefixed `[nav-probe]` so the run can be filtered out of the
 * Metro log with a single grep.
 */
export function attachNavProbe(ref: NavContainerRef, label?: string): () => void {
  let sequence = 0;

  console.log(
    `[nav-probe] attached${label ? ` for ${label}` : ""}. ` +
    `Stack now: ${describeStack(readRootState(ref))}`
  );
  console.log(
    `[nav-probe] Tap the back chevron. Three outcomes, three different fixes:\n` +
    `[nav-probe]   nothing logged        -> the press never reaches JS\n` +
    `[nav-probe]   action logged NOOP    -> a navigator refused it\n` +
    `[nav-probe]   action, stack same    -> it was applied and then undone\n` +
    `[nav-probe] Expect POP from a native chevron, GO_BACK from a ScreenHeader ` +
    `back button. Do not read "no POP" off a Pattern B screen as a defect.`
  );

  // Fires before the state change is applied, so this is the "before" line.
  const offAction = ref.addListener("__unsafe_action__", (event) => {
    const sequenceNumber = ++sequence;
    const { action, noop } = event.data;
    const extras = action as { payload?: unknown; source?: string; target?: string };
    console.log(
      `[nav-probe] #${sequenceNumber} ${action.type}${noop ? "  *** NOOP — no navigator handled it ***" : ""}\n` +
      `[nav-probe] #${sequenceNumber}   payload ${brief(extras.payload)}\n` +
      `[nav-probe] #${sequenceNumber}   source=${String(extras.source)} target=${String(extras.target)}\n` +
      `[nav-probe] #${sequenceNumber}   stack before: ${describeStack(readRootState(ref))}`
    );
  });

  const offState = ref.addListener("state", (event) => {
    console.log(
      `[nav-probe]      stack after:  ${describeStack(event.data.state as ProbeNavState | undefined)}`
    );
  });

  return () => {
    offAction();
    offState();
    console.log("[nav-probe] detached");
  };
}
