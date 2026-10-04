import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useData } from "@/lib/data-context";
import Colors from "@/constants/colors";

/**
 * Says, on the screen people actually open, that something did not sync.
 *
 * AUDIT L30 asked for a user-visible surface rather than a log. A row in
 * Settings is where the detail belongs, but nobody opens Settings to check
 * whether their work saved — so a refusal also says so here, on the sites list,
 * and leads to the screen that explains it.
 *
 * Renders NOTHING when there is nothing to say. An "all synced" banner on every
 * launch is how a warning stops being read, and the pending case is not a
 * warning at all: waiting for coverage on a site with no coverage is the normal
 * state of this app, so it is shown quietly and only while it is true.
 */
export function SyncStatusBanner() {
  const { pendingCount, failedOps } = useData();

  if (failedOps.length === 0 && pendingCount === 0) return null;

  const failed = failedOps.length > 0;
  const count = failed ? failedOps.length : pendingCount;

  return (
    <Pressable
      onPress={() => router.push("/settings/offline-sync")}
      style={({ pressed }) => [
        styles.banner,
        failed ? styles.bannerFailed : styles.bannerPending,
        pressed && { opacity: 0.85 },
      ]}
    >
      <Ionicons
        name={failed ? "alert-circle" : "cloud-upload-outline"}
        size={18}
        color={failed ? Colors.errorText : Colors.infoText}
      />
      <Text style={[styles.text, { color: failed ? Colors.errorText : Colors.infoText }]}>
        {failed
          ? `${count} ${count === 1 ? "item" : "items"} did not send`
          : `${count} ${count === 1 ? "item" : "items"} waiting for coverage`}
      </Text>
      <Ionicons
        name="chevron-forward"
        size={16}
        color={failed ? Colors.errorText : Colors.infoText}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bannerFailed: { backgroundColor: Colors.errorBg, borderColor: Colors.errorBorder },
  bannerPending: { backgroundColor: Colors.infoBg, borderColor: Colors.infoBorder },
  text: { flex: 1, fontSize: 13, fontWeight: "600" },
});
