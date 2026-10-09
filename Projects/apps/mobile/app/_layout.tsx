import * as Sentry from "@sentry/react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack, useNavigationContainerRef, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/query-client";
import { AuthProvider } from "@/lib/auth-context";
import { DataProvider } from "@/lib/data-context";
import { logResolvedApiBaseUrlOnce } from "@/lib/api-base-url";
import { resumeTrackingIfEnabled } from "@/lib/location-service";
import { ONBOARDING_COMPLETE_KEY } from "./onboarding";
import Constants from "expo-constants";
import Colors from "@/constants/colors";

const sentryDsn = (Constants.expoConfig?.extra as { sentryDsn?: string } | undefined)?.sentryDsn
  || process.env.EXPO_PUBLIC_SENTRY_DSN;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: __DEV__ ? "development" : "production",
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
    // Deliberately off, and the Privacy Policy says so.
    //
    // A screenshot is a photograph of whatever was on screen when the app
    // crashed, which on the capture screens is the note text, the site address
    // and the photographs themselves. `lib/sync-telemetry-redaction.ts` exists
    // to keep exactly that content out of a telemetry payload; attaching a
    // picture of it would make that work pointless. Do not turn this on without
    // deciding, in writing, what a crash on new-entry.tsx is allowed to send.
    attachScreenshot: false,
    enableNativeFramesTracking: true,
    sendDefaultPii: false,
    beforeSend(event) {
      // Strip any auth tokens or cookies that may appear in breadcrumbs/request data.
      if (event.request?.headers) {
        delete event.request.headers["authorization"];
        delete event.request.headers["cookie"];
      }
      return event;
    },
  });
}

// Dev-only navigation probe for the inert back chevron. The require sits INSIDE
// `if (__DEV__)` on purpose: a top-level import ships the module in production
// bundles, a gated require eliminates it entirely — see the header of
// lib/dev-nav-probe.ts. Do not convert this to an import.
let DevNavProbe: typeof import("@/lib/dev-nav-probe") | null = null;
if (__DEV__) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  DevNavProbe = require("@/lib/dev-nav-probe");
}

SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
  // Dev-only: drive the Add Signature layout probe.
  //
  // This is navigation, not measurement — the probe itself lives in
  // lib/dev-signature-probe.tsx behind a gated require. A deep link would be
  // the obvious trigger and does NOT work here: expo-dev-launcher claims the
  // `sitesnap://` scheme in a development build, so `simctl openurl` never
  // reaches expo-router (verified — `sitesnap://privacy-policy` does not
  // navigate either). An env var read at bundle time is the mechanism that
  // actually works. Everything below is stripped from production bundles.
  const router = useRouter();
  useEffect(() => {
    if (!__DEV__) return;
    if (process.env.EXPO_PUBLIC_SIGNATURE_PROBE !== "1") return;
    const t = setTimeout(() => router.push("/inspections/__signature_probe__"), 1500);
    return () => clearTimeout(t);
  }, [router]);

  // Dev-only: the navigation probe. EXPO_PUBLIC_NAV_PROBE names the route to
  // open — e.g. `terms-of-service` — and any non-empty value also attaches the
  // action/state listener that is the actual instrument. Same env-var trigger
  // as above and for the same reason: expo-dev-launcher claims `sitesnap://` in
  // a development build, so `simctl openurl` never reaches expo-router.
  //
  // Written as a literal `process.env.EXPO_PUBLIC_NAV_PROBE` member access on
  // purpose: Expo inlines these at build time by static substitution, so a
  // dynamic lookup would read undefined in a bundled app.
  const navRef = useNavigationContainerRef();
  useEffect(() => {
    if (!__DEV__) return;
    const probeRoute = process.env.EXPO_PUBLIC_NAV_PROBE;
    if (!probeRoute) return;
    const detach = DevNavProbe?.attachNavProbe(navRef, probeRoute);
    // Push the route under test, then hand over to the person tapping. The
    // listener is what measures; this only saves nine manual navigations.
    const t = setTimeout(
      () => router.push(probeRoute as Parameters<typeof router.push>[0]),
      1500
    );
    return () => {
      clearTimeout(t);
      detach?.();
    };
  }, [navRef, router]);

  return (
    <>
      {/* Navy-forward chrome: navy headers/tab bar need light status-bar content. */}
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerBackTitle: "Back",
          // Every native-stack header in this file is now painted explicitly
          // rather than inheriting one from iOS.
          //
          // app.config.ts declares `userInterfaceStyle: "automatic"` while
          // constants/colors.ts is a single fixed LIGHT palette with no dark
          // counterpart. A UINavigationBar with no headerStyle is drawn by iOS,
          // not by us, so it followed the SYSTEM appearance: in dark appearance
          // it renders near-black, and `headerTintColor: Colors.primary`
          // (#0F2B46, navy) then drew a navy back chevron onto near-black —
          // present and tappable but invisible. Nine screens were in that
          // state; the one reported from the device was terms-of-service.
          //
          // Navy rather than Colors.surface, for two reasons beyond taste. The
          // StatusBar style="light" above declares white status-bar content for
          // the whole app, which is wrong over a light nav bar — so these nine
          // screens were also broken in LIGHT appearance today, just less
          // visibly. And the comment on that StatusBar states navy chrome as
          // the intent. The cost is a visual difference from ScreenHeader's
          // default light variant on the Pattern B screens; that is a real
          // inconsistency and is called out in the PR rather than fixed by
          // quietly restyling screens nobody reported.
          //
          // These props stay when app.config.ts flips to userInterfaceStyle
          // "light" in the next native build: explicit beats inherited. See
          // docs/DECISIONS.md ADR-0002.
          headerStyle: { backgroundColor: Colors.primary },
          headerTintColor: Colors.white,
          headerTitleStyle: { color: Colors.white },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="signup" options={{ headerShown: false }} />
        <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
        <Stack.Screen name="reset-password" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="create-site"
        options={{
          title: "New Site",
          presentation: "modal",
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="site/[id]"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="entry/[id]"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="new-entry"
        options={{
          title: "New Entry",
          presentation: "modal",
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="diary/[siteId]"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="diary-gallery/[siteId]"
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="profile"
        options={{
          title: "Profile",
          presentation: "modal",
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="export-diaries"
        options={{
          title: "Export Diaries",
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="backup-data"
        options={{
          title: "Backup Data",
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="privacy-policy"
        options={{
          title: "Privacy Policy",
          headerShown: true,
        }}
      />
      {/* terms-of-service was reachable (Settings pushed to it) but never
          registered, so it fell through to the bare root screenOptions and
          showed its raw route name ("terms-of-service") as the header title,
          native-stack's default. Registered here to match privacy-policy, its
          sibling. */}
      <Stack.Screen
        name="terms-of-service"
        options={{
          title: "Terms of Service",
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="help-support"
        options={{
          title: "Help & Support",
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="supervisor-dashboard"
        options={{
          title: "Dashboard",
          headerShown: true,
        }}
      />
      <Stack.Screen name="invite" options={{ headerShown: false }} />
      <Stack.Screen name="site-invite" options={{ headerShown: false }} />
      <Stack.Screen name="company-invite" options={{ headerShown: false }} />
      <Stack.Screen name="onboarding" options={{ headerShown: false }} />
      <Stack.Screen name="crew/[siteId]" options={{ headerShown: false }} />
      <Stack.Screen name="incidents/[siteId]" options={{ headerShown: false }} />
      <Stack.Screen name="inspections/[siteId]" options={{ headerShown: false }} />
      <Stack.Screen name="deliveries/[siteId]" options={{ headerShown: false }} />
      {/* Settings drill-down. Pattern B (headerShown: false + shared
          ScreenHeader), matching the other pushed detail screens. */}
      <Stack.Screen name="settings/account" options={{ headerShown: false }} />
      <Stack.Screen name="settings/data-privacy" options={{ headerShown: false }} />
      <Stack.Screen name="settings/about" options={{ headerShown: false }} />
      {/* settings/offline-sync was the one screen rendering ScreenHeader that
          was never registered here, so it fell through to the root
          screenOptions — which set colours but never `headerShown: false` —
          and showed BOTH a native "‹ Back" bar and its own "‹ Offline Sync"
          header below it. Two back affordances, one screen. Same omission as
          terms-of-service above, different symptom. AUDIT L59. */}
      <Stack.Screen name="settings/offline-sync" options={{ headerShown: false }} />
    </Stack>
    </>
  );
}

function RootLayout() {
  useEffect(() => {
    logResolvedApiBaseUrlOnce();
    void resumeTrackingIfEnabled();
    SplashScreen.hideAsync();
    AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY).then((val) => {
      if (!val) router.replace("/onboarding");
    }).catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DataProvider>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <RootLayoutNav />
            </GestureHandlerRootView>
          </DataProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

// Cast resolves pnpm dual-@types/react path that TS can't name through Sentry.wrap's return type
const AppLayout = (sentryDsn ? Sentry.wrap(RootLayout) : RootLayout) as unknown as typeof RootLayout;
export default AppLayout;
