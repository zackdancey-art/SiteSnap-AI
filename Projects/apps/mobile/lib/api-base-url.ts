import Constants from "expo-constants";

type ExpoExtra = {
  apiUrl?: string;
};

function getHostFromExpoRuntime(): string | null {
  const expoConfigHostUri = (Constants.expoConfig as { hostUri?: string } | null)?.hostUri;
  if (expoConfigHostUri && typeof expoConfigHostUri === "string") {
    return expoConfigHostUri.split(":")[0] || null;
  }
  const debuggerHost = (
    Constants as unknown as {
      manifest2?: { extra?: { expoGo?: { debuggerHost?: string } } };
      manifest?: { debuggerHost?: string };
    }
  ).manifest2?.extra?.expoGo?.debuggerHost ||
    (Constants as unknown as { manifest?: { debuggerHost?: string } }).manifest?.debuggerHost;

  if (debuggerHost && typeof debuggerHost === "string") {
    return debuggerHost.split(":")[0] || null;
  }

  return null;
}

function isLocalhostUrl(url: string) {
  return /localhost|127\.0\.0\.1/i.test(url);
}

function isLanUrl(url: string) {
  return /^http:\/\//i.test(url);
}

// "Local" means either a loopback address or plain http — the same two predicates the
// release-build guard below refuses. A dev API is one or the other; the production API
// is neither, which is what makes the two guards exact mirror images of each other.
function isLocalApiUrl(url: string) {
  return isLocalhostUrl(url) || isLanUrl(url);
}

// The API listens on 4000 (`services/api/src/server.ts`), and the EAS `development`
// profile already sets `http://localhost:4000`. AUDIT L2 records that three packages
// disagreed on this port and prescribes agreeing on 4000; this is that agreement.
const DEV_DEFAULT_API_URL = "http://localhost:4000";

// Opt-in escape hatch for the rare case of pointing a dev client at a deployed API on
// purpose. It lives in code rather than in `.env` because `.env` is gitignored, so no
// commit can reach it and no review can see what it was set to.
const ALLOW_PROD_API_ENV_VAR = "EXPO_PUBLIC_ALLOW_PROD_API";

function prodApiAllowedInDev() {
  // Written as a literal `process.env.EXPO_PUBLIC_…` member access on purpose: Expo
  // inlines these at build time by static substitution, so a dynamic lookup such as
  // process.env[ALLOW_PROD_API_ENV_VAR] would read undefined in a bundled app. The
  // constant above is for message text only.
  return process.env.EXPO_PUBLIC_ALLOW_PROD_API === "1";
}

function normalizeUrl(url: string) {
  return url.trim().replace(/\/$/, "");
}

export function resolveApiBaseUrl(): string {
  const expoExtra = Constants.expoConfig?.extra as ExpoExtra | undefined;
  const envBase =
    process.env.EXPO_PUBLIC_API_BASE_URL ||
    process.env.EXPO_PUBLIC_API_URL ||
    "";

  const candidate = normalizeUrl(envBase || expoExtra?.apiUrl || "");

  if (!candidate) {
    if (!__DEV__) {
      // A release build with no API URL configured is non-functional.
      // Throw early rather than silently hitting a LAN address that won't exist in the field.
      throw new Error(
        "[api] Production build is missing EXPO_PUBLIC_API_BASE_URL. " +
        "Set it in your EAS build profile (eas.json) and rebuild."
      );
    }
    const host = getHostFromExpoRuntime();
    if (host) {
      const runtimeGuess = `http://${host}:4000`;
      console.warn(`[api] Missing API base URL; using runtime host guess ${runtimeGuess}`);
      return runtimeGuess;
    }
    console.warn(
      `[api] No API base URL configured and no dev host could be detected; ` +
      `falling back to ${DEV_DEFAULT_API_URL}. ` +
      `Set EXPO_PUBLIC_API_URL in your .env (e.g. http://<your-machine-LAN-IP>:4000) if the API is not local.`
    );
    return DEV_DEFAULT_API_URL;
  }

  if (!__DEV__ && (isLocalhostUrl(candidate) || isLanUrl(candidate))) {
    throw new Error(
      `[api] Production build has an invalid API URL: "${candidate}". ` +
      "Release builds must use an HTTPS URL. Set EXPO_PUBLIC_API_BASE_URL in eas.json and rebuild."
    );
  }

  // The mirror image of the guard above, and the reason this file was changed.
  //
  // Every guard here used to run in one direction: they protected a release build from
  // dev values. Nothing protected dev from *production* values, so `expo start` with
  // EXPO_PUBLIC_API_URL=https://<the real API> was accepted in silence — which meant
  // local development read and wrote the live customer database. Refuse it by default
  // and require an explicit opt-in to do it on purpose.
  //
  // This cannot affect a release build (`__DEV__` is false there, so the branch is
  // unreachable) and cannot affect an EAS build (all four profiles in eas.json set the
  // URL explicitly, and the `development` profile already sets localhost).
  if (__DEV__ && !isLocalApiUrl(candidate)) {
    if (!prodApiAllowedInDev()) {
      throw new Error(
        `[api] Refusing to use the non-local API URL "${candidate}" in a development build.\n` +
        `A dev build pointed at a deployed API reads and writes real customer data.\n` +
        `Either point it at a local API (e.g. ${DEV_DEFAULT_API_URL}) in Projects/apps/mobile/.env,\n` +
        `or, if you mean to do this, set ${ALLOW_PROD_API_ENV_VAR}=1 in the same file and restart Expo.`
      );
    }
    return candidate;
  }

  if (isLocalhostUrl(candidate)) {
    const host = getHostFromExpoRuntime();
    if (host) {
      const runtimeGuess = `http://${host}:4000`;
      console.warn(`[api] Localhost URL detected (${candidate}); using detected dev host ${runtimeGuess}`);
      return runtimeGuess;
    }
    throw new Error(
      `[api] Localhost API URL "${candidate}" won't work from a device/simulator, and no dev host could ` +
      "be detected. Set EXPO_PUBLIC_API_URL to your machine's LAN IP (e.g. http://192.168.x.x:4000) and restart Expo."
    );
  }

  return candidate;
}

let logged = false;

export function logResolvedApiBaseUrlOnce() {
  if (logged) return;
  logged = true;
  const base = resolveApiBaseUrl();
  console.log(`[api] Resolved base URL: ${base}`);

  // Loud, once, at boot — because the opt-in is the one configuration in which a
  // development build can write to production, and it should never be in effect
  // without the person running it knowing.
  if (__DEV__ && !isLocalApiUrl(base)) {
    console.warn(
      `[api] ⚠️  ${ALLOW_PROD_API_ENV_VAR}=1 is set and this dev build is talking to ${base}.\n` +
      `[api] ⚠️  Anything you do in the app from here writes to that deployment.`
    );
  }
}

export function getApiBaseUrl() {
  return resolveApiBaseUrl();
}
