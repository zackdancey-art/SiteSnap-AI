import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useData } from "@/lib/data-context";
import { describeEntrySyncState } from "@/lib/entry-sync-state";
import Colors from "@/constants/colors";

/**
 * Says whether THIS entry has reached the server — AUDIT L37's remaining half.
 *
 * L37's disposition: "the per-entry indicator is the remaining half and is the
 * more useful one, because the question a person actually asks is 'has *this*
 * entry arrived', not 'is anything pending'." SyncStatusBanner answers the
 * second question on the sites list; this answers the first, on the entry.
 *
 * Renders NOTHING for an entry that has arrived, for the same reason the banner
 * does: a tick on every row in a list where everything has synced — which is
 * the normal state — trains people to stop reading the row, and the one row that
 * says something different then gets skipped with the rest. Absence of a badge
 * is the "arrived" state, and it is the state almost every entry is in.
 *
 * It takes the entry id rather than the entry, because `Entry.isPending` is not
 * a usable signal (set once, never cleared — see lib/entry-sync-state.ts) and
 * passing the whole entry would invite a future reader to reach for it.
 */
export function EntrySyncBadge({ entryId }: { entryId: string }) {
  const { entrySyncStates } = useData();
  const state = entrySyncStates[entryId];
  const label = describeEntrySyncState(state);

  if (!label) return null;

  const failed = state === "failed";

  return (
    <View style={[styles.badge, failed ? styles.badgeFailed : styles.badgePending]}>
      <Ionicons
        name={failed ? "alert-circle" : "cloud-upload-outline"}
        size={12}
        color={failed ? Colors.errorText : Colors.warningText}
      />
      <Text style={[styles.label, failed ? styles.labelFailed : styles.labelPending]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  badgePending: { backgroundColor: Colors.warningBg, borderColor: Colors.warningBorder },
  badgeFailed: { backgroundColor: Colors.errorBg, borderColor: Colors.errorBorder },
  label: { fontSize: 11, fontWeight: "600" },
  labelPending: { color: Colors.warningText },
  labelFailed: { color: Colors.errorText },
});
