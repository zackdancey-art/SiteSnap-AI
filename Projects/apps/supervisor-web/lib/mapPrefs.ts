/**
 * The Live Map preferences: one definition of the key, the shape and the
 * defaults, imported by both the page that writes them and the page that reads
 * them.
 *
 * It is one module rather than two copies because of how this broke. The
 * settings page wrote `sitesnap.mapPrefs` to localStorage and had a complete
 * panel of three controls over it; `locations/page.tsx` polled on a hardcoded
 * `30_000`, coloured workers against a hardcoded hour, and never read the key
 * at all. So all three controls persisted a value, re-displayed it on reload,
 * and changed nothing about the map — the worst kind of control, because it
 * looks like it worked (AUDIT L50).
 *
 * A reader and a writer in separate files, each with its own literal for the
 * key and its own idea of the default, is the shape that failure takes. With
 * one module they cannot disagree about either.
 *
 * STILL LOCAL, AND STILL PER-BROWSER. These are company-level settings living
 * in localStorage, so they do not follow a manager to another device and two
 * managers at one company can hold different values. That is pre-existing and
 * deliberate — the settings page's own comment says they "stay local-only
 * until they get a company home", unlike the personal settings, which go
 * through `/api/account/settings`. Wiring them up does not change that; it
 * only makes the controls honest about the browser they are set in.
 */

export const MAP_PREFS_KEY = "sitesnap.mapPrefs";

export type MapPrefs = {
  /** Seconds between polls of /api/location/workers. */
  refreshInterval: number;
  /** Whether workers past the stale cutoff appear on the map and in the list. */
  showInactiveWorkers: boolean;
  /** Minutes without a ping after which a worker counts as inactive. */
  staleCutoffMinutes: number;
};

export const MAP_PREFS_DEFAULTS: MapPrefs = {
  refreshInterval: 30,
  showInactiveWorkers: true,
  staleCutoffMinutes: 60,
};

/** The option sets the settings page offers, so the reader can reject anything else. */
export const REFRESH_INTERVAL_OPTIONS = [15, 30, 60, 120, 300] as const;
export const STALE_CUTOFF_OPTIONS = [30, 60, 120, 240] as const;

/**
 * Read the stored preferences, falling back per field.
 *
 * Every field is validated against the options the settings page actually
 * offers rather than merely type-checked. A hand-edited `refreshInterval: 0`
 * would otherwise become `setInterval(…, 0)` — a request loop as fast as the
 * browser will go, against a live API, from a page a manager leaves open all
 * day. localStorage is user-writable, so this is input, not state.
 *
 * Returns the defaults on the server and in any browser where localStorage
 * throws or holds nothing, so the first render is identical either way and
 * nothing here can cause a hydration mismatch (L49).
 */
export function readMapPrefs(): MapPrefs {
  if (typeof window === "undefined") return MAP_PREFS_DEFAULTS;
  try {
    const raw = localStorage.getItem(MAP_PREFS_KEY);
    if (!raw) return MAP_PREFS_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<MapPrefs>;
    return {
      refreshInterval: (REFRESH_INTERVAL_OPTIONS as readonly number[]).includes(Number(parsed.refreshInterval))
        ? Number(parsed.refreshInterval)
        : MAP_PREFS_DEFAULTS.refreshInterval,
      showInactiveWorkers:
        typeof parsed.showInactiveWorkers === "boolean"
          ? parsed.showInactiveWorkers
          : MAP_PREFS_DEFAULTS.showInactiveWorkers,
      staleCutoffMinutes: (STALE_CUTOFF_OPTIONS as readonly number[]).includes(Number(parsed.staleCutoffMinutes))
        ? Number(parsed.staleCutoffMinutes)
        : MAP_PREFS_DEFAULTS.staleCutoffMinutes,
    };
  } catch {
    return MAP_PREFS_DEFAULTS;
  }
}

export function writeMapPrefs(prefs: MapPrefs): void {
  try {
    localStorage.setItem(MAP_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode, or the quota is full: the control still reflects the session */
  }
}

/** "30 seconds" / "2 minutes", for the label that tells a manager what is happening. */
export function describeInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** "1 hour" / "30 minutes", for the legend. */
export function describeCutoff(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
