import React, { useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ClientInput, useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import { canManageClients, describeFailure } from "@/lib/permissions";
import { isSessionExpired } from "@/lib/session";
import Colors from "@/constants/colors";
import { Client } from "@/lib/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLIENTS. FILING, NOT ACCESS. THE BODY, WITHOUT THE SCREEN CHROME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lists the company's clients with how many sites each holds, and for a manager
 * or owner adds, edits and deletes them.
 *
 * WHY THIS IS A COMPONENT AND NOT A SCREEN
 *
 * Clients and Sites are two views of one screen, by decision — a client is a
 * grouping of sites and nothing else. So this body is rendered in two places
 * and is the same code in both:
 *
 *   - app/(tabs)/index.tsx, under the Sites | Clients switcher, which is where
 *     a person goes for it. It replaced a row in Settings, which is where
 *     nobody would look for a list of clients.
 *   - app/clients.tsx, still a route, because "Manage clients" in the site
 *     picker (app/create-site.tsx:352, app/site/[id].tsx:540) pushes to it and
 *     because `screen-header-audit.test.ts` pins that route as registered with
 *     the native header hidden. That screen is now a ScreenHeader and this
 *     component, and nothing else.
 *
 * It owns its own add control — the "+ New client" row at the top of the list,
 * not a button in the screen chrome — precisely so that both hosts get the
 * same affordance without either having to reach into this component's state.
 * The alternative, handing `openCreate` upward through a render prop, is how
 * two hosts end up with two different add buttons that drift apart.
 *
 * WHY THE SCREEN IS NOT GATED AND THE CONTROLS ARE
 *
 * GET /clients is behind identity, not rank, deliberately: the site a crew
 * member is standing on is filed under one of these names, and the grouped site
 * list takes its headings from here. So crew see the list, read-only, and the
 * add/edit/delete controls are absent rather than present-and-refusing —
 * `canManageClients` draws them, `requireAtLeast("manager")` on the three write
 * routes enforces it, and this component is not the enforcement (see the header
 * of lib/permissions.ts).
 *
 * WHAT DELETING DOES, because it is the one destructive-looking control here:
 * it UNFILES the client's sites and deletes none of them. The confirmation says
 * so with the real number, taken from `siteCount` on the list, and the API
 * returns the count it actually unfiled, which is what the success message
 * quotes rather than the number we predicted.
 */
export function ClientsView({
  bottomInset = 40,
  onSeeSites,
}: {
  /** Space below the last card. The tab host passes its measured tab-bar inset. */
  bottomInset?: number;
  /**
   * What "See sites grouped by client" does. The tab host switches its own view
   * back, which is not a navigation at all; the route host pushes to the tab.
   */
  onSeeSites?: () => void;
}) {
  const { clients, addClient, updateClient, deleteClient } = useData();
  const { user } = useAuth();
  const canManage = canManageClients(user?.companyRole);

  const [editing, setEditing] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ClientInput>(emptyForm());

  const openCreate = () => {
    setForm(emptyForm());
    setEditing(null);
    setCreating(true);
  };

  const openEdit = (client: Client) => {
    setForm({
      name: client.name,
      contactName: client.contactName,
      contactEmail: client.contactEmail,
      contactPhone: client.contactPhone,
      notes: client.notes,
    });
    setEditing(client);
    setCreating(true);
  };

  const closeForm = () => {
    setCreating(false);
    setEditing(null);
  };

  const submit = async () => {
    const name = form.name.trim();
    if (!name) {
      Alert.alert("Name required", "A client needs a name. Everything else is optional.");
      return;
    }
    setSaving(true);
    try {
      const payload: ClientInput = {
        name,
        contactName: form.contactName.trim(),
        contactEmail: form.contactEmail.trim(),
        contactPhone: form.contactPhone.trim(),
        notes: form.notes.trim(),
      };
      if (editing) {
        await updateClient(editing.id, payload);
      } else {
        await addClient(payload);
      }
      closeForm();
    } catch (err) {
      if (isSessionExpired(err)) return;
      /**
       * The 409 is the one refusal worth its own words. The API answers it with
       * the id of the client that already holds the name, because the useful
       * thing to say is "you already have one of these", not "invalid".
       *
       * Checked on the STATUS rather than by matching the prose: the message is
       * the server's to change, and lib/invite-refusal.ts exists because a
       * screen once picked its wording by searching an error string for tokens
       * that were never in it.
       */
      const status = (err as { status?: unknown } | null)?.status;
      if (status === 409) {
        Alert.alert("Already a client", `You already have a client called "${name}".`);
        return;
      }
      Alert.alert("Could not save", describeFailure(err, "Could not save this client."));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (client: Client) => {
    const siteWord = client.siteCount === 1 ? "site" : "sites";
    Alert.alert(
      `Delete ${client.name}?`,
      client.siteCount > 0
        ? `Its ${client.siteCount} ${siteWord} will become unfiled. No site, entry, diary or photograph is deleted.`
        : "This client has no sites filed under it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const unfiled = await deleteClient(client.id);
              if (unfiled > 0) {
                // The number the SERVER unfiled, not the one we predicted.
                // They disagree whenever another device filed a site between
                // the list arriving and this tap.
                Alert.alert(
                  "Client deleted",
                  `${unfiled} ${unfiled === 1 ? "site is" : "sites are"} now unfiled.`
                );
              }
            } catch (err) {
              if (isSessionExpired(err)) return;
              Alert.alert("Could not delete", describeFailure(err, "Could not delete this client."));
            }
          },
        },
      ]
    );
  };

  const seeSites = onSeeSites ?? (() => router.push("/(tabs)"));

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        {/* The add control lives in the list, not in the screen chrome, so that
            both hosts get the same one. Absent for crew rather than disabled —
            see the header of this file. */}
        {canManage && (
          <Pressable
            style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.85 }]}
            onPress={openCreate}
            testID="add-client-button"
          >
            <Ionicons name="add" size={20} color={Colors.white} />
            <Text style={styles.addRowText}>New client</Text>
          </Pressable>
        )}

        {clients.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="briefcase-outline" size={56} color={Colors.textTertiary} />
            <Text style={styles.emptyTitle}>No clients yet</Text>
            <Text style={styles.emptyText}>
              {canManage
                ? "Add a client, then file sites under it. Sites with no client stay visible as Unfiled."
                : "Nobody has added a client yet. Sites with no client show as Unfiled."}
            </Text>
          </View>
        ) : (
          clients.map((client) => (
            <View key={client.id} style={styles.card} testID={`client-card-${client.id}`}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIcon}>
                  <Ionicons name="briefcase" size={20} color={Colors.accent} />
                </View>
                <View style={styles.cardHeaderText}>
                  <Text style={styles.cardTitle} numberOfLines={1}>{client.name}</Text>
                  <Text style={styles.cardMeta}>
                    {client.siteCount} {client.siteCount === 1 ? "site" : "sites"}
                  </Text>
                </View>
                {canManage && (
                  <View style={styles.cardActions}>
                    <Pressable
                      style={styles.iconButton}
                      onPress={() => openEdit(client)}
                      hitSlop={6}
                      testID={`edit-client-${client.id}`}
                    >
                      <Ionicons name="pencil-outline" size={18} color={Colors.textSecondary} />
                    </Pressable>
                    <Pressable
                      style={styles.iconButton}
                      onPress={() => confirmDelete(client)}
                      hitSlop={6}
                      testID={`delete-client-${client.id}`}
                    >
                      <Ionicons name="trash-outline" size={18} color={Colors.error} />
                    </Pressable>
                  </View>
                )}
              </View>

              {/* Every contact line is conditional. A client added mid-job has a
                  name and nothing else — ClientSchema requires only the name —
                  and empty rows with icons beside them read as missing data
                  rather than as data nobody entered. */}
              {(client.contactName || client.contactEmail || client.contactPhone || client.notes) && (
                <View style={styles.cardBody}>
                  {!!client.contactName && (
                    <Detail icon="person-outline" text={client.contactName} />
                  )}
                  {!!client.contactEmail && (
                    <Detail icon="mail-outline" text={client.contactEmail} />
                  )}
                  {!!client.contactPhone && (
                    <Detail icon="call-outline" text={client.contactPhone} />
                  )}
                  {!!client.notes && <Detail icon="document-text-outline" text={client.notes} lines={3} />}
                </View>
              )}
            </View>
          ))
        )}

        {clients.length > 0 && (
          <Pressable style={styles.sitesLink} onPress={seeSites}>
            <Ionicons name="business-outline" size={16} color={Colors.accent} />
            <Text style={styles.sitesLinkText}>See sites grouped by client</Text>
          </Pressable>
        )}
      </ScrollView>

      <Modal visible={creating} transparent animationType="fade" onRequestClose={closeForm}>
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editing ? "Edit client" : "New client"}</Text>
            <ScrollView style={styles.modalScroll} keyboardShouldPersistTaps="handled">
              <Field
                label="Name"
                value={form.name}
                onChangeText={(name) => setForm((f) => ({ ...f, name }))}
                placeholder="e.g. Meridian Properties"
                testID="client-name-input"
              />
              <Field
                label="Contact name"
                value={form.contactName}
                onChangeText={(contactName) => setForm((f) => ({ ...f, contactName }))}
                placeholder="Optional"
              />
              <Field
                label="Email"
                value={form.contactEmail}
                onChangeText={(contactEmail) => setForm((f) => ({ ...f, contactEmail }))}
                placeholder="Optional"
                keyboardType="email-address"
              />
              <Field
                label="Phone"
                value={form.contactPhone}
                onChangeText={(contactPhone) => setForm((f) => ({ ...f, contactPhone }))}
                placeholder="Optional"
                keyboardType="phone-pad"
              />
              <Field
                label="Notes"
                value={form.notes}
                onChangeText={(notes) => setForm((f) => ({ ...f, notes }))}
                placeholder="Optional"
                multiline
              />
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable style={styles.modalSecondary} onPress={closeForm} disabled={saving}>
                <Text style={styles.modalSecondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.modalPrimary, (pressed || saving) && { opacity: 0.85 }]}
                onPress={submit}
                disabled={saving}
                testID="save-client-button"
              >
                <Ionicons name="checkmark" size={18} color={Colors.white} />
                <Text style={styles.modalPrimaryText}>{saving ? "Saving..." : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function emptyForm(): ClientInput {
  return { name: "", contactName: "", contactEmail: "", contactPhone: "", notes: "" };
}

function Detail({
  icon,
  text,
  lines = 1,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  text: string;
  lines?: number;
}) {
  return (
    <View style={styles.detail}>
      <Ionicons name={icon} size={14} color={Colors.textTertiary} />
      <Text style={styles.detailText} numberOfLines={lines}>{text}</Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  keyboardType?: "email-address" | "phone-pad";
  multiline?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.formGroup}>
      <Text style={styles.formLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Colors.textTertiary}
        keyboardType={keyboardType}
        autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"}
        multiline={multiline}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  // The in-list add control. 48 tall because it is a primary action under a
  // thumb, which is the minimum this codebase holds tap targets to (AUDIT L51).
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: Colors.accent,
  },
  addRowText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: Colors.white },
  // paddingBottom comes from the `bottomInset` prop, not from here.
  content: { padding: 16, gap: 12 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    shadowColor: Colors.cardShadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 2,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
  },
  cardHeaderText: { flex: 1 },
  cardTitle: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: Colors.text },
  cardMeta: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginTop: 1,
  },
  cardActions: { flexDirection: "row", gap: 4 },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
  cardBody: {
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.borderLight,
  },
  detail: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  detailText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  sitesLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 48,
    marginTop: 4,
  },
  sitesLinkText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.accent },
  emptyState: { alignItems: "center", justifyContent: "center", paddingTop: 72, gap: 12 },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", color: Colors.text },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    textAlign: "center",
    paddingHorizontal: 32,
    lineHeight: 20,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: Colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modalCard: {
    width: "100%",
    maxHeight: "86%",
    borderRadius: 16,
    backgroundColor: Colors.surface,
    padding: 16,
    gap: 10,
  },
  modalScroll: { flexGrow: 0 },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: Colors.text },
  formGroup: { gap: 6, marginBottom: 12 },
  formLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    marginLeft: 4,
  },
  input: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  inputMultiline: { height: 88, paddingTop: 12, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  modalSecondary: {
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  modalSecondaryText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.textSecondary },
  modalPrimary: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: Colors.accent,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  modalPrimaryText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: Colors.white },
});
