import type { ExpoConfig, ConfigContext } from "expo/config";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require("./package.json") as { version?: string };

// APP_ENV is set per EAS build profile (see eas.json).
// Anything other than "production" is treated as a dev/preview build for the
// purposes of App Transport Security below.
const APP_ENV = process.env.APP_ENV ?? "development";
const IS_DEV = APP_ENV !== "production";

// EAS Update is baked into production AND preview builds, on SEPARATE channels
// (see eas.json), so an update published to preview can never be delivered to a
// production user — the channel is compiled into the binary, and each channel
// maps to its own branch on EAS.
//
// The "simulator" profile deliberately sets APP_ENV=simulator and therefore
// gets no updates config at all: it exists for UI review on a Mac, not for
// exercising the update path, and a build that silently swapped its JS out
// from under a reviewer would make "what am I looking at" unanswerable.
//
// NOTE when publishing: runtimeVersion only exists when this flag is on, so
// `eas update` must be run with APP_ENV set, e.g.
//   APP_ENV=preview eas update --branch preview --message "..."
// Running it bare would publish against a config that has no runtimeVersion.
const UPDATES_ENABLED = APP_ENV === "production" || APP_ENV === "preview";

const buildStamp = new Date().toISOString().replace("T", " ").slice(0, 16);

export default ({ config }: ConfigContext): ExpoConfig => {
  // Single source for the project ID: written into app.json by `eas init` and
  // read through here, so the update URL cannot drift from the linked project.
  const projectId = (
    config.extra as { eas?: { projectId?: string } } | undefined
  )?.eas?.projectId;

  return {
    ...config,
    name: "SiteSnap AI",
    slug: "sitesnap",
    scheme: "sitesnap",
    version: pkg.version || "1.0.0",
    orientation: "portrait",
    jsEngine: "hermes",
    platforms: ["ios", "android", "web"],
    icon: "./images/icon.png",
    userInterfaceStyle: "automatic",
    splash: {
      image: "./images/splash.png",
      resizeMode: "contain",
      backgroundColor: "#0F2B46",
    },
    // OTA updates for production and preview, on separate channels (see above).
    ...(UPDATES_ENABLED
      ? {
          updates: {
            url: `https://u.expo.dev/${projectId}`,
            enabled: true,
            checkAutomatically: "ON_LOAD",
            fallbackToCacheTimeout: 0,
          },
          // "appVersion" ties update compatibility to `version` (1.0.0): JS-only
          // fixes ship as updates within a version, and bumping the version means a
          // new binary — updates published after the bump will not reach the old one.
          runtimeVersion: { policy: "appVersion" },
        }
      : {}),
    ios: {
      bundleIdentifier: "nz.getsitesnapai.app",
      supportsTablet: true,
      infoPlist: {
        NSCameraUsageDescription:
          "SiteSnap uses your camera to capture construction site photos for daily diaries.",
        NSPhotoLibraryUsageDescription:
          "SiteSnap accesses your photo library to attach existing site photos to diary entries.",
        NSPhotoLibraryAddUsageDescription:
          "SiteSnap saves exported site diaries and photos to your library.",
        NSLocationWhenInUseUsageDescription:
          "SiteSnap uses your location to auto-fill weather conditions for site diary entries.",
        NSMicrophoneUsageDescription:
          "SiteSnap may use the microphone when recording video on site.",
        NSLocalNetworkUsageDescription:
          "SiteSnap uses local network access to communicate with the development API server.",
        NSUserNotificationsUsageDescription:
          "SiteSnap sends push notifications to alert you about new site entries, diary approvals, and incidents.",
        ITSAppUsesNonExemptEncryption: false,
        // NSAllowsArbitraryLoads must be false in release builds (App Store requirement).
        // Dev builds allow plain HTTP to reach the local dev API server.
        NSAppTransportSecurity: IS_DEV
          ? { NSAllowsArbitraryLoads: true }
          : {
              NSAllowsArbitraryLoads: false,
              NSExceptionDomains: {
                localhost: {
                  NSThirdPartyExceptionAllowsInsecureHTTPLoads: true,
                  NSThirdPartyExceptionRequiresForwardSecrecy: false,
                  NSIncludesSubdomains: true,
                },
              },
            },
      },
    },
    android: {
      package: "nz.getsitesnapai.app",
      adaptiveIcon: {
        foregroundImage: "./images/icon.png",
        backgroundColor: "#0F2B46",
      },
      permissions: [
        "CAMERA",
        "READ_MEDIA_IMAGES",
        "ACCESS_FINE_LOCATION",
        "ACCESS_COARSE_LOCATION",
        "RECEIVE_BOOT_COMPLETED",
        "VIBRATE",
      ],
    },
    plugins: [
      "expo-router",
      "expo-font",
      [
        "@sentry/react-native/expo",
        {
          // Uploads source maps so Sentry can de-obfuscate stack traces.
          //
          // NOT optional, despite what this comment used to claim. This plugin
          // adds an Xcode build phase that runs `sentry-cli`, and that phase
          // FAILS THE BUILD when it cannot find an org — "error: An organization
          // ID or slug is required (provide with --org)". It is not a warning and
          // there is no silent degrade to "no source maps". Two ways to satisfy it:
          //
          //   1. Set SENTRY_ORG + SENTRY_PROJECT + SENTRY_AUTH_TOKEN in the EAS
          //      build environment. This is what production and preview do — see
          //      `eas env:list`. Source maps upload and production stack traces
          //      are readable.
          //   2. Set SENTRY_DISABLE_AUTO_UPLOAD=true. This is what the simulator
          //      and development profiles do in eas.json: they are for local UI
          //      review, the JS is not shipped anywhere, and uploading its source
          //      maps would only pollute the Sentry project with noise releases.
          //
          // A profile that does NEITHER does not build. If you add a build profile
          // to eas.json, it needs one of the two.
          //
          // Native crash reporting does still work without source maps — but a
          // JS-layer error, which is most of what this app can throw, arrives as
          // minified frames that are nearly useless for diagnosis. That is why
          // production uploads rather than disabling.
        },
      ],
      ...(UPDATES_ENABLED ? ["expo-updates"] : []),
      [
        "expo-location",
        {
          locationWhenInUsePermission:
            "SiteSnap uses your location to auto-fill weather conditions for site entries.",
        },
      ],
      [
        "expo-notifications",
        {
          icon: "./images/icon.png",
          color: "#0F2B46",
          defaultChannel: "default",
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission:
            "SiteSnap accesses your photos to attach site images to diary entries.",
          cameraPermission:
            "SiteSnap uses your camera to capture construction site photos.",
        },
      ],
      [
        "expo-build-properties",
        {
          ios: { deploymentTarget: "16.4" },
          android: {
            compileSdkVersion: 35,
            targetSdkVersion: 35,
            minSdkVersion: 24,
            enableProguardInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
          },
        },
      ],
    ],
    extra: {
      ...(config.extra ?? {}),
      appVersion: pkg.version || "1.0.0",
      buildVersion: buildStamp,
      // Production URL is injected by the EAS build profile env (see eas.json).
      // Falls back to "" so resolveApiBaseUrl() will throw early in release builds
      // if the variable is not set, rather than silently using a LAN address.
      apiUrl:
        process.env.EXPO_PUBLIC_API_BASE_URL ||
        process.env.EXPO_PUBLIC_API_URL ||
        "",
      // `eas` (projectId) is written into app.json by `eas init` and arrives here
      // through the `...config.extra` spread at the top of this object. Do NOT
      // hardcode it below the spread: assigning it here overrides whatever eas
      // init writes, which is exactly how this config sat on a literal
      // "FILL-AFTER-eas-init" placeholder while looking configured.
    },
  };
};
