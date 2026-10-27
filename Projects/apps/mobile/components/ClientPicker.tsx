import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { Client } from "@/lib/types";

/**
 * The client picker, used by BOTH surfaces that file a site: app/create-site.tsx
 * and app/site/[id].tsx.
 *
 * One component rather than two copies, because the two things that are easy to
 * get subtly different between copies are the two that matter most here: that
 * "Unfiled" is always an option (so a site can be taken back OUT of a client,
 * which is the half a picker usually forgets), and that an empty list says "no
 * clients yet" rather than implying a failure or a refusal.
 *
 * It holds no state and makes no requests. The caller owns the selection and
 * the write, which is what lets the create screen use it against a value that
 * has not been saved yet and the site screen use it against one that has.
 *
 * `canManage` decides only whether the "Manage clients" affordance is drawn —
 * it is lib/permissions.ts canManageClients at every call site. Picking is NOT
 * gated here: the caller decides whether to open this at all, because the gate
 * that matters is PATCH /projects/sites/:id being manager+ at the API.
 */
export type ClientPickerProps = {
  visible: boolean;
  clients: Client[];
  /** Null means the unfiled row is the selected one. */
  selectedClientId: string | null;
  onSelect: (clientId: string | null) => void;
  onClose: () => void;
  canManage: boolean;
  onManage?: () => void;
};

export function ClientPicker({
  visible,
  clients,
  selectedClientId,
  onSelect,
  onClose,
  canManage,
  onManage,
}: ClientPickerProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The backdrop dismisses. onRequestClose above only covers the Android
          back button, and a modal with no way out but a button is the shape
          that traps people on a screen. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Swallows the press so a tap on the card does not dismiss it. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>File under client</Text>
            <Pressable onPress={onClose} hitSlop={10} testID="client-picker-close">
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {/* UNFILED IS FIRST AND ALWAYS PRESENT. Taking a site back out of a
                client is as ordinary as putting it in, and the API supports it
                directly (clientId: null). A picker that only offers clients
                makes filing a one-way door. */}
            <Row
              label="No client"
              hint="Unfiled"
              icon="remove-circle-outline"
              selected={selectedClientId === null}
              onPress={() => onSelect(null)}
              testID="client-picker-unfiled"
            />

            {clients.map((client) => (
              <Row
                key={client.id}
                label={client.name}
                hint={`${client.siteCount} ${client.siteCount === 1 ? "site" : "sites"}`}
                icon="briefcase-outline"
                selected={selectedClientId === client.id}
                onPress={() => onSelect(client.id)}
                testID={`client-picker-${client.id}`}
              />
            ))}

            {clients.length === 0 && (
              /* NOT "could not load clients" and not "you do not have access".
                 An empty list here is indistinguishable from a company that has
                 not added a client yet — refresh() swallows a failed
                 GET /clients deliberately (see lib/data-context.tsx) — so this
                 says the one thing that is true in every case. */
              <Text style={styles.emptyText}>
                No clients yet. Sites stay unfiled until a client is added.
              </Text>
            )}
          </ScrollView>

          {canManage && onManage && (
            <Pressable style={styles.manageRow} onPress={onManage} testID="client-picker-manage">
              <Ionicons name="settings-outline" size={16} color={Colors.accent} />
              <Text style={styles.manageText}>Manage clients</Text>
            </Pressable>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({
  label,
  hint,
  icon,
  selected,
  onPress,
  testID,
}: {
  label: string;
  hint: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed]}
      onPress={onPress}
      testID={testID}
    >
      <Ionicons name={icon} size={18} color={selected ? Colors.accent : Colors.textSecondary} />
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, selected && styles.rowLabelSelected]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.rowHint}>{hint}</Text>
      </View>
      {selected && <Ionicons name="checkmark-circle" size={20} color={Colors.accent} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: Colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxHeight: "72%",
    borderRadius: 16,
    backgroundColor: Colors.surface,
    padding: 16,
    gap: 8,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  list: {
    flexGrow: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    // 56 rather than 44: these rows are tapped with a glove on, and 44 is the
    // floor rather than the target. AUDIT L51.
    minHeight: 56,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  rowSelected: {
    backgroundColor: Colors.accent + "12",
  },
  rowPressed: {
    opacity: 0.85,
  },
  rowText: {
    flex: 1,
  },
  rowLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.text,
  },
  rowLabelSelected: {
    fontFamily: "Inter_600SemiBold",
  },
  rowHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginTop: 1,
  },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    paddingHorizontal: 12,
    paddingVertical: 16,
    lineHeight: 19,
  },
  manageRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 48,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  manageText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.accent,
  },
});
