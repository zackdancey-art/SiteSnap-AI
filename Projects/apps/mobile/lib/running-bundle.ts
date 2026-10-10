/**
 * Which JavaScript bundle is this app actually running?
 *
 * Settings -> About has always shown Application.nativeBuildVersion, which is
 * read out of the installed binary. An over-the-air update cannot move it. So
 * after an `eas update` the screen still says "1.0.0 (4)" while the code on the
 * phone is something else entirely, and there is no way to tell from the device
 * whether a published update actually arrived. "Results from a stale binary are
 * not results" needs a way to check, and the build number is not it.
 *
 * This module answers the question from expo-updates' own view of the launch,
 * and it is deliberately pure: it takes a plain snapshot of the fields rather
 * than importing expo-updates itself. Two reasons. The node test program
 * (tsconfig.test.json) can only compile modules with no React Native imports,
 * and every branch below is a state that is awkward or impossible to reproduce
 * on a device by hand - an emergency launch most of all.
 *
 * THE TRAP, and the reason the embedded case is spelled out in words:
 * Updates.updateId is NOT null when the app is running the bundle baked into
 * the binary. It is null only when expo-updates is disabled altogether, which
 * in practice means a development build. So `updateId ?? "built-in"` would
 * print a real, legitimate-looking UUID for a device that has never received
 * an over-the-air update - which is precisely the ambiguity this screen exists
 * to remove. isEmbeddedLaunch is the field that distinguishes them, and it is
 * checked BEFORE updateId is read. Do not reorder those two branches.
 */

/**
 * The subset of the expo-updates module this decision needs. Field names and
 * nullability match expo-updates 29.0.20's exported constants exactly, so
 * `describeRunningBundle(Updates, Platform.OS)` type-checks at the call site
 * with no adapter object in between.
 */
export type UpdatesSnapshot = {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId: string | null;
  channel: string | null;
  createdAt: Date | null;
  isEmergencyLaunch?: boolean;
  emergencyLaunchReason?: string | null;
};

export type RunningBundle =
  /** An over-the-air update is running. `updateId` is the thing to compare against a publish. */
  | { kind: "ota"; updateId: string; detail: string }
  /** The bundle inside the binary is running. No id is shown, on purpose - see the header. */
  | { kind: "embedded"; words: string; emergencyReason: string | null }
  /** expo-updates is switched off: a development build. */
  | { kind: "disabled"; words: string }
  /** There is no over-the-air mechanism on this platform at all: the web build. */
  | { kind: "unavailable"; words: string }
  /** Enabled, native, not embedded, yet no id. Should not happen; say so rather than inventing one. */
  | { kind: "unknown"; words: string };

/**
 * UTC rather than device-local, and labelled. The point of this line is to be
 * compared against the `createdAt` in `eas update:list` output, which is UTC,
 * and toLocaleString would make that comparison a timezone puzzle for whoever
 * is holding the phone. It also keeps the tests independent of the machine's
 * timezone - this repo's CI and the author's shell are thirteen hours apart.
 */
export function formatBundleCreatedAt(createdAt: Date | null): string | null {
  if (!createdAt) return null;
  const ms = createdAt.getTime();
  // An Invalid Date is a real possibility: the value is deserialised from the
  // update manifest, and toISOString() throws a RangeError on it rather than
  // returning null.
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * `platform` is passed in rather than read from React Native here, because
 * this module must stay importable by the node test program. It matters for
 * one reason: expo-updates' web implementation reports `isEnabled: true` with
 * no `updateId`, which is otherwise indistinguishable from the "should not
 * happen" state on a phone. Web has no over-the-air mechanism to identify, so
 * it gets said plainly instead of raising a false alarm. Omitted means native.
 */
export function describeRunningBundle(snapshot: UpdatesSnapshot, platform?: string): RunningBundle {
  if (platform === "web") {
    return {
      kind: "unavailable",
      words: "This is the web build. Over-the-air updates apply to the iPhone and Android apps only.",
    };
  }

  if (!snapshot.isEnabled) {
    return {
      kind: "disabled",
      words:
        "Over-the-air updates are off in this build, so there is no update to identify. " +
        "This is a development build.",
    };
  }

  // Before updateId, always. See THE TRAP in the header.
  if (snapshot.isEmbeddedLaunch) {
    const reason = snapshot.isEmergencyLaunch ? snapshot.emergencyLaunchReason ?? "no reason given" : null;
    return {
      kind: "embedded",
      words: snapshot.isEmergencyLaunch
        ? "Running the built-in bundle because a downloaded update failed to start. " +
          "The app fell back to the JavaScript shipped inside this build."
        : "Running the built-in bundle - the JavaScript shipped inside this build. " +
          "No over-the-air update has been applied.",
      emergencyReason: reason,
    };
  }

  if (!snapshot.updateId) {
    return {
      kind: "unknown",
      words:
        "Updates are on and this is not the built-in bundle, but the update has no id. " +
        "Report this - it should not happen.",
    };
  }

  const created = formatBundleCreatedAt(snapshot.createdAt);
  const parts: string[] = [];
  if (snapshot.channel) parts.push(`${snapshot.channel} channel`);
  if (created) parts.push(`published ${created}`);

  return {
    kind: "ota",
    updateId: snapshot.updateId,
    detail: parts.length > 0 ? parts.join(" · ") : "Over-the-air update",
  };
}
