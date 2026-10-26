import { useEffect, useRef, useState } from "react";
import { authedJson } from "@/lib/authed-fetch";
import { isSessionExpired } from "@/lib/session";
import { derivePortfolioMetrics, type PortfolioMetrics } from "@/lib/portfolio-metrics";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; metrics: PortfolioMetrics }
  | { status: "error"; message: string };

/**
 * Portfolio totals for the manager dashboard's metric cards. AUDIT L98.
 *
 * The twin of apps/supervisor-web/lib/usePortfolioSummary.ts — same four
 * states, same `enabled` flag, same 15-second ceiling — because the two
 * dashboards are supposed to show the same figures and the quickest way for
 * them to diverge is for each to fetch them its own way.
 *
 * ONE DIFFERENCE FROM THE PORTAL'S, DELIBERATE
 *
 * This one hands back DERIVED metrics rather than the raw summary, so no screen
 * on this surface ever holds an unvalidated wire object. `eas update` reaches a
 * phone whenever the phone next launches and is batched separately from the API
 * deploy, so this is the one client that can genuinely be newer than the server
 * it is talking to; `derivePortfolioMetrics` returns null for a payload missing
 * any figure, and that becomes the error state below rather than the word
 * "undefined" in a card. The portal, which is deployed with the API, keeps the
 * simpler shape.
 *
 * WHY `enabled`, AND WHY IT IS NOT A PERMISSION
 *
 * `GET /projects/summary` is `requireAtLeast("viewer")` at the API, and this
 * surface shows the dashboard to manager+ (`canSeeSupervisorDashboard` in
 * lib/permissions.ts). A hook cannot be called conditionally, so without this
 * flag the screen would fire a request on every crew load that its own render
 * is about to refuse. The flag withholds the REQUEST, not the refusal —
 * removing it would waste a round trip, not expose a number. The refusal is the
 * route's.
 */
export function usePortfolioSummary(enabled: boolean): State {
  const [state, setState] = useState<State>(enabled ? { status: "loading" } : { status: "idle" });
  const didFetch = useRef(false);

  useEffect(() => {
    if (!enabled || didFetch.current) return;
    didFetch.current = true;

    let cancelled = false;

    // Same ceiling as the portal's hook and as useBootstrap, for the same
    // reason: a card that never resolves reads as a number still loading
    // rather than as a failure.
    const timer = setTimeout(() => {
      if (cancelled) return;
      setState({ status: "error", message: "Request timed out — check your connection." });
    }, 15_000);

    authedJson<unknown>("/api/projects/summary")
      .then((payload) => {
        clearTimeout(timer);
        if (cancelled) return;
        const metrics = derivePortfolioMetrics(payload);
        if (!metrics) {
          // An API that answered but did not send the figures. Named as a
          // version mismatch because that is the realistic cause and because
          // "failed to load" would send someone looking at their signal.
          setState({ status: "error", message: "The server sent totals this app version cannot read." });
          return;
        }
        setState({ status: "ok", metrics });
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        if (cancelled) return;
        // A dead session is reported once, by lib/session.ts, and the app is
        // already navigating to sign-in. Describing it again here in this
        // screen's own words is the habit lib/authed-fetch.ts exists to stop.
        if (isSessionExpired(err)) return;
        const msg = err instanceof Error ? err.message : "Failed to load totals.";
        setState({ status: "error", message: msg });
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled]);

  return state;
}
