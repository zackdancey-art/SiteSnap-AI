import * as Sentry from "@sentry/react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
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
    attachScreenshot: true,
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

SplashScreen.preventAutoHideAsync();

function RootLayoutNav() {
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
          title: "Supervisor Dashboard",
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
