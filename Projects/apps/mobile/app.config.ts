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

/**
 * LOCATION PERMISSION DECLARATIONS -- REMOVED DELIBERATELY, AND CHEAP TO RESTORE.
 *
 * AUDIT L60. This app declared the iOS NSLocationWhenInUseUsageDescription
 * purpose string (twice -- once here in `ios.infoPlist` and once through the
 * `expo-location` config plugin, both writing the same Info.plist key) and the
 * Android ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION permissions, for a
 * feature that has no entry point in the shipping app.
 *
 * lib/location-service.ts still exports requestPermissionAndStart, startTracking
 * and setLocationTrackingEnabled, and nothing calls any of them. The module's
 * only external importer is app/_layout.tsx, which calls resumeTrackingIfEnabled;
 * the persisted flag that resumes can never have been set, because its only
 * writer is requestPermissionAndStart. So the binary was telling App Store
 * review that SiteSnap collects location, for a capability no user can switch
 * on. Declaring a permission the app cannot request is a documented review
 * rejection reason, and nobody has asked for the feature yet.
 *
 * WHAT WAS REMOVED IS WRITTEN OUT BELOW RATHER THAN DELETED, so restoring it is
 * uncommenting rather than rediscovering. Four places, all in this file:
 *
 * // const LOCATION_WHEN_IN_USE_PURPOSE =
 * //   "SiteSnap uses your location to record where site photos and diary entries were made, " +
 * //   "and to fill in local weather conditions. If your employer enables location tracking, " +
 * //   "SiteSnap also records your location while you are using the app for work; you can see " +
 * //   "whether that is on in Settings.";
 * //
 * // ios.infoPlist:       NSLocationWhenInUseUsageDescription: LOCATION_WHEN_IN_USE_PURPOSE,
 * // android.permissions: "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION",
 * // plugins:             ["expo-location", { locationWhenInUsePermission: LOCATION_WHEN_IN_USE_PURPOSE }],
 *
 * The three use sites are each marked `L60:` where they stood.
 *
 * KEEP THAT WORDING if the feature comes back. The string above is already the
 * repaired one: the two declarations used to carry different text (`ios.infoPlist`
 * said "...for site diary entries", the plugin said "...for site entries"), and
 * because both write the same key, which sentence a user actually saw depended on
 * config-plugin mod ordering with nothing reporting the disagreement. It was then
 * widened from weather-only to cover tracking, because a prompt that says
 * "weather" while the app records where someone is working is a false statement at
 * the exact moment consent is being asked for.
 *
 * `expo-location` stays in package.json on purpose. Expo autolinking reads
 * dependencies, not this `plugins` array, so the native module is still linked and
 * the surviving `import * as Location from "expo-location"` in
 * lib/location-service.ts compiles and boots exactly as before -- removing a
 * plugin entry removes the Info.plist string, not the module.
 *
 * Restoring any of this needs a NATIVE REBUILD. None of it takes effect through
 * `eas update`.
 *
 * Guarded by lib/native-permission-audit.test.ts, which asserts over this file's
 * source with comments stripped first -- so the block above cannot satisfy it.
 */

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
    // Locked to light. The palette in constants/colors.ts is light-only — there
    // is no Colors.dark — so "automatic" let iOS draw system-appearance chrome
    // (navigation bars, content views, pickers) against light-only content. In
    // dark appearance that produced near-black backgrounds behind dark text and
    // a navy chevron on near-black. See docs/DECISIONS.md ADR-0002: this flips
    // back to "automatic" only when a real Colors.dark exists.
    //
    // The explicit per-component props (headerStyle, headerTintColor,
    // themeVariant) STAY. Explicit beats inherited, and they are what protects
    // the OTA-updatable JS layer if this value is ever changed again.
    userInterfaceStyle: "light",
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
      // Universal Links for crew invitations. Invitation emails previously
      // linked to sitesnap://invite?token=..., which does nothing on a device
      // that does not already have the app — i.e. every invited crew member.
      //
      // MUST be the www host, not the apex. getsitesnapai.com 301-redirects
      // every path (including /.well-known/) to www, and Apple does NOT follow
      // redirects when fetching the AASA file — so an apex entitlement would
      // install cleanly and silently never activate. Measured, not assumed.
      //
      // Paired with website/.well-known/apple-app-site-association, which must
      // be served from https://www.getsitesnapai.com with Content-Type
      // application/json. appID there is <appleTeamId from eas.json>.<this
      // bundleIdentifier> = 3FALF4GK4D.nz.getsitesnapai.app.
      //
      // The sitesnap:// scheme above is unchanged and keeps working: the API
      // builds the invite URL from process.env.INVITE_URL and falls back to the
      // custom scheme, and app/+native-intent.tsx already matches BOTH forms.
      associatedDomains: ["applinks:www.getsitesnapai.com"],
      infoPlist: {
        NSCameraUsageDescription:
          "SiteSnap uses your camera to capture construction site photos for daily diaries.",
        NSPhotoLibraryUsageDescription:
          "SiteSnap accesses your photo library to attach existing site photos to diary entries.",
        NSPhotoLibraryAddUsageDescription:
          "SiteSnap saves exported site diaries and photos to your library.",
        // L60: NSLocationWhenInUseUsageDescription removed -- see the block at the top of this file.
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
        // L60: ACCESS_FINE_LOCATION and ACCESS_COARSE_LOCATION removed -- see the block at the top of this file.
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
      // L60: the "expo-location" plugin entry removed -- see the block at the top of this file.
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
