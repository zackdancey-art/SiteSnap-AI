import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SettingsBody, SettingsBodyStrong, SettingsCard, SettingsSection } from "@/components/SettingsSection";
import { useData } from "@/lib/data-context";
import type { QueuedOp } from "@/lib/offline-queue";
import Colors from "@/constants/colors";

/**
 * Offline sync — the surface AUDIT L30 was missing.
 *
 * The drain used to delete any op the server refused and write one line to a
 * console that does not exist on a phone. So a site diary entry rejected for a
 * validation error disappeared, and the only person who could ever have found
 * out was whoever later noticed the week looked thin. The op is now retained
 * with why it failed, and this screen is where a person sees that, because a
 * log is not a surface.
 *
 * Deliberately NOT on this screen: anything that discards a failed op. The op
 * holds the only copy of work somebody did on a site, and throwing that away is
 * a retention decision for the person who owns the records rather than a button
 * on a settings screen.
 */
export default function OfflineSyncScreen() {
  const { pendingCount, failedOps, retryFailedSync } = useData();
  const [retrying, setRetrying] = useState(false);

  const onRetry = async (ids?: string[]) => {
    setRetrying(true);
    try {
      const retried = await retryFailedSync(ids);
      if (retried === 0) Alert.alert("Nothing to retry", "These items are no longer waiting.");
    } catch (err) {
      Alert.alert("Retry failed", err instanceof Error ? err.message : "Could not retry.");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <View style={styles.container}>
      <ScreenHeader title="Offline Sync" paddingBottom={16} homeFallback="/(tabs)/settings" />
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <SettingsSection title="Waiting to send">
          <SettingsCard>
            <View style={styles.statusRow}>
              <View style={[styles.statusIcon, { backgroundColor: Colors.infoBg }]}>
                <Ionicons name="cloud-upload-outline" size={20} color={Colors.info} />
              </View>
              <Text style={styles.statusText}>
                {pendingCount === 0
                  ? "Everything on this phone has been sent."
                  : `${pendingCount} ${pendingCount === 1 ? "item is" : "items are"} waiting for coverage.`}
              </Text>
            </View>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="Did not send"
          description={
            failedOps.length === 0
              ? undefined
              : "These were refused by the server, so retrying on its own will not help. They are kept on this phone until you retry them."
          }
        >
          <SettingsCard>
            {failedOps.length === 0 ? (
              <View style={styles.statusRow}>
                <View style={[styles.statusIcon, { backgroundColor: Colors.successBg }]}>
                  <Ionicons name="checkmark-circle-outline" size={20} color={Colors.successText} />
                </View>
                <Text style={styles.statusText}>Nothing has failed to send.</Text>
              </View>
            ) : (
              failedOps.map((op, index) => (
                <FailedRow key={op.id} op={op} first={index === 0} />
              ))
            )}
          </SettingsCard>

          {failedOps.length > 0 && (
            <Pressable
              onPress={() => onRetry()}
              disabled={retrying}
              style={({ pressed }) => [styles.retryButton, (pressed || retrying) && { opacity: 0.7 }]}
            >
              <Ionicons name="refresh" size={18} color={Colors.white} />
              <Text style={styles.retryButtonText}>
                {retrying ? "Retrying…" : `Retry ${failedOps.length === 1 ? "this item" : "all items"}`}
              </Text>
            </Pressable>
          )}
        </SettingsSection>

        <SettingsSection title="What this screen is for">
          <SettingsCard>
            <SettingsBody>
              <SettingsBodyStrong>Why it is kept rather than retried. </SettingsBodyStrong>
              An item lands here when the server answered and refused it — a rule it
              did not satisfy, or a site you no longer have access to. Sending it
              again unchanged gets the same answer, so the app stops trying and waits
              for you. Fix whatever it names, then retry.
            </SettingsBody>
          </SettingsCard>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

/** What a human needs to act: what it was, when, and what the server said. */
function FailedRow({ op, first }: { op: QueuedOp; first: boolean }) {
  const failure = op.failure;
  return (
    <View style={[styles.failedRow, !first && styles.failedRowDivided]}>
      <View style={[styles.statusIcon, { backgroundColor: Colors.errorBg }]}>
        <Ionicons name="alert-circle-outline" size={20} color={Colors.errorText} />
      </View>
      <View style={styles.failedBody}>
        <Text style={styles.failedTitle}>{describeOp(op)}</Text>
        <Text style={styles.failedMeta}>
          {failure?.stage === "upload" ? "Photographs would not upload" : "The server refused it"}
          {failure?.status ? ` · ${failure.status}` : ""}
          {failure?.failedAt ? ` · ${formatWhen(failure.failedAt)}` : ""}
        </Text>
        {!!failure?.message && <Text style={styles.failedReason}>{failure.message}</Text>}
        {failure?.photosUploaded !== undefined && (
          <Text style={styles.failedMeta}>
            {failure.photosUploaded} photograph{failure.photosUploaded === 1 ? "" : "s"} already sent
          </Text>
        )}
        {(op.attempts ?? 0) > 1 && (
          <Text style={styles.failedMeta}>Refused {op.attempts} times</Text>
        )}
      </View>
    </View>
  );
}

/**
 * Says what the item was without quoting what was typed into it. The note text
 * is the user's own, and this row is the wrong size for it.
 */
function describeOp(op: QueuedOp): string {
  switch (op.type) {
    case "addEntry": {
      const date = (op.payload as { date?: string } | null)?.date;
      const photos = (op.payload as { photos?: unknown[] } | null)?.photos?.length ?? 0;
      return `Site diary entry${date ? ` — ${date}` : ""}${photos ? ` · ${photos} photo${photos === 1 ? "" : "s"}` : ""}`;
    }
    case "addSite":
      return "New site";
    case "updateEntry":
      return "Edit to a site diary entry";
    case "deleteEntry":
      return "Deletion of a site diary entry";
    case "deleteSite":
      return "Deletion of a site";
  }
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  scrollContent: { paddingBottom: 48 },
  statusRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  statusIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  statusText: { flex: 1, fontSize: 14, color: Colors.text, lineHeight: 20 },
  failedRow: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  failedRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border },
  failedBody: { flex: 1, gap: 2 },
  failedTitle: { fontSize: 15, fontWeight: "600", color: Colors.text },
  failedMeta: { fontSize: 12, color: Colors.textSecondary },
  failedReason: { fontSize: 13, color: Colors.errorText, marginTop: 2 },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    marginHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: Colors.accent,
  },
  retryButtonText: { color: Colors.white, fontSize: 15, fontWeight: "600" },
});
