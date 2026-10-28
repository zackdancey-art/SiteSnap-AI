"use client";

import { useState, useEffect, useRef } from "react";
import { fetchPortfolioSummary, isAuthenticated } from "@/lib/api";
import type { PortfolioSummary } from "@/lib/api";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: PortfolioSummary }
  | { status: "error"; message: string };

/**
 * Portfolio totals for the dashboard's metric cards. AUDIT L98.
 *
 * Deliberately a second request rather than more fields on `/projects/bootstrap`.
 * The bootstrap payload is the field app's whole working set and is already the
 * largest response the API sends; the dashboard needs eight integers, and asking
 * for them separately is what lets the cards be correct while the site table
 * below them still renders from the (capped) bootstrap list.
 *
 * WHY `enabled`, AND WHY IT IS NOT A CONVENIENCE
 *
 * `GET /projects/summary` is `requireAtLeast("viewer")`, so crew are refused at
 * the API. A hook cannot be called conditionally, so without this flag the
 * dashboard would fire a request it knows will 403 on every crew load — and the
 * dashboard already refuses crew in its own render. Passing
 * `canSeeSupervisorDashboard` keeps the client's request and the server's gate
 * in agreement: that predicate is `!isCrew`, which is the same population
 * `requireAtLeast("viewer")` admits.
 *
 * The flag withholds the REQUEST, not the refusal. It is not a permission —
 * removing it would waste a round trip and log a 403, not expose a number.
 */
export function usePortfolioSummary(enabled: boolean): State {
  const [state, setState] = useState<State>(enabled ? { status: "loading" } : { status: "idle" });
  const didFetch = useRef(false);

  useEffect(() => {
    if (!enabled || didFetch.current) return;
    didFetch.current = true;

    if (!isAuthenticated()) return;

    // Same 15-second ceiling as useBootstrap, for the same reason: a card that
    // never resolves reads as a number still loading rather than as a failure.
    const timer = setTimeout(() => {
      setState({ status: "error", message: "Request timed out — is the API server running?" });
    }, 15_000);

    fetchPortfolioSummary()
      .then((data) => {
        clearTimeout(timer);
        setState({ status: "ok", data });
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : "Failed to load totals.";
        setState({ status: "error", message: msg });
      });

    return () => clearTimeout(timer);
  }, [enabled]);

  return state;
}
