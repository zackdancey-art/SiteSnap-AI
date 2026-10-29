import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  Alert,
  Modal,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import { canFileSiteUnderClient } from "@/lib/permissions";
import { ClientPicker } from "@/components/ClientPicker";
import { JOB_NUMBER_MAX_LENGTH, normaliseJobNumber } from "@/lib/job-number";
import Colors from "@/constants/colors";
import { AddressSuggestion, fetchAddressSuggestions } from "@/lib/geo";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";

export default function CreateSiteScreen() {
  const { addSite, clients } = useData();
  const { user } = useAuth();
  const canFile = canFileSiteUnderClient(user?.companyRole);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [addressLoading, setAddressLoading] = useState(false);
  const [client, setClient] = useState("");
  /**
   * OPTIONAL, and never validated. `validate()` below deliberately does not
   * mention it: every site created before PR 2 has no job number and must stay
   * valid, so requiring one here would make the field a gate on a screen it is
   * an annotation on.
   */
  const [jobNumber, setJobNumber] = useState("");
  /**
   * The CLIENT ID is separate from the client LABEL above, and both are sent.
   *
   * `client` is the free-text label the API still requires (SiteSchema keeps
   * `client: z.string().min(1)`), and it is what pre-032 sites have and all
   * that the search box on the sites tab reads. `clientId` is the filing.
   *
   * Picking a client here overwrites the label with that client's name, which
   * is what PATCH /projects/sites/:id does server-side when a site is filed
   * later — so a site filed at creation and a site filed afterwards end up
   * identical rather than diverging on where it was done.
   *
   * Choosing "No client" clears the id and LEAVES the label, for the same
   * reason unfiling leaves it: the typed name is the only record of who the
   * job is for once the filing is gone.
   */
  const [clientId, setClientId] = useState<string | null>(null);
  const [showClientPicker, setShowClientPicker] = useState(false);
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0]);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [dateDraft, setDateDraft] = useState(new Date(`${new Date().toISOString().split("T")[0]}T00:00:00`));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isDirty = Boolean(name.trim() || address.trim() || client.trim() || clientId);
  const markSaved = useUnsavedChangesGuard(isDirty);

  useEffect(() => {
    let isCancelled = false;
    const q = address.trim();
    if (q.length < 3) {
      setAddressSuggestions([]);
      setAddressLoading(false);
      return;
    }

    setAddressLoading(true);
    const timer = setTimeout(async () => {
      try {
        const suggestions = await fetchAddressSuggestions(q);
        if (!isCancelled) {
          setAddressSuggestions(suggestions);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("Address suggestions failed:", error);
          setAddressSuggestions([]);
        }
      } finally {
        if (!isCancelled) {
          setAddressLoading(false);
        }
      }
    }, 250);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [address]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = "Site name is required";
    if (!address.trim()) newErrors.address = "Address is required";
    if (!client.trim()) newErrors.client = "Client name is required";
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleCreate = async () => {
    if (!validate()) return;
    try {
      await addSite({
        name: name.trim(),
        address: address.trim(),
        client: client.trim(),
        startDate,
        status: "active",
        // SENT ALWAYS, and as "" when empty -- not omitted the way clientId is
        // below. The two fields spell absence differently: clientId is
        // nullable, so an absent key and a null agree; job_number is
        // `TEXT NOT NULL DEFAULT ''` (migration 011), so "" is its only
        // absence and sending it keeps this payload -- which the offline queue
        // stores and replays -- a complete Site rather than one the replay has
        // to guess at.
        jobNumber: normaliseJobNumber(jobNumber),
        // Omitted rather than sent as null when nothing is picked. An absent
        // key and a null both mean unfiled to SiteSchema (`.nullish()`), and
        // the payload is also what the offline queue stores and replays, so
        // the smaller one is the one worth persisting.
        ...(clientId ? { clientId } : {}),
      });
      markSaved();
      router.back();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create site.";
      Alert.alert("Create Site Failed", message);
    }
  };

  /**
   * Picking a client REWRITES the label; clearing it does not.
   *
   * Asymmetric on purpose, and the asymmetry is the server's: filing sets
   * project_sites.client to the canonical client name, and unfiling leaves
   * whatever was there. Doing anything else here would mean a site created
   * with a client picked carried a different label from the same site filed a
   * minute later from its detail screen.
   */
  const handleClientSelect = (nextId: string | null) => {
    setClientId(nextId);
    if (nextId) {
      const picked = clients.find((c) => c.id === nextId);
      if (picked) {
        setClient(picked.name);
        setErrors((e) => ({ ...e, client: "" }));
      }
    }
    setShowClientPicker(false);
  };

  const handleDateChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (Platform.OS !== "ios") {
      setShowDatePicker(false);
    }
    if (selectedDate) {
      if (Platform.OS === "ios") {
        setDateDraft(selectedDate);
      } else {
        setStartDate(selectedDate.toISOString().split("T")[0]);
      }
    }
  };

  const openDatePicker = () => {
    const current = new Date(`${startDate}T00:00:00`);
    setDateDraft(current);
    setShowDatePicker(true);
  };

  const applyDateDraft = () => {
    setStartDate(dateDraft.toISOString().split("T")[0]);
    setShowDatePicker(false);
  };

  const formattedStartDate = new Date(`${startDate}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const formattedDraftDate = dateDraft.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.formGroup}>
          <Text style={styles.label}>Site Name</Text>
          <TextInput
            style={[styles.input, !!errors.name && styles.inputError]}
            placeholder="e.g. Riverside Office Complex"
            placeholderTextColor={Colors.textTertiary}
            value={name}
            onChangeText={(t) => { setName(t); setErrors((e) => ({ ...e, name: "" })); }}
          />
          {!!errors.name && <Text style={styles.errorText}>{errors.name}</Text>}
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Address</Text>
          <TextInput
            style={[styles.input, !!errors.address && styles.inputError]}
            placeholder="e.g. 142 River Road, Melbourne VIC"
            placeholderTextColor={Colors.textTertiary}
            value={address}
            onChangeText={(t) => { setAddress(t); setErrors((e) => ({ ...e, address: "" })); }}
          />
          {addressLoading && <Text style={styles.addressLoadingText}>Searching addresses...</Text>}
          {addressSuggestions.length > 0 && (
            <View style={styles.suggestionsCard}>
              {addressSuggestions.map((item) => (
                <Pressable
                  key={`${item.displayName}-${item.lat ?? ""}-${item.lon ?? ""}`}
                  style={styles.suggestionRow}
                  onPress={() => {
                    setAddress(item.displayName);
                    setAddressSuggestions([]);
                    setErrors((e) => ({ ...e, address: "" }));
                  }}
                >
                  <Ionicons name="location-outline" size={16} color={Colors.textSecondary} />
                  <Text numberOfLines={2} style={styles.suggestionText}>
                    {item.displayName}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {!!errors.address && <Text style={styles.errorText}>{errors.address}</Text>}
        </View>

        <View style={styles.formGroup}>
          <Text style={styles.label}>Client</Text>
          <TextInput
            style={[styles.input, !!errors.client && styles.inputError]}
            placeholder="e.g. Meridian Properties"
            placeholderTextColor={Colors.textTertiary}
            value={client}
            onChangeText={(t) => { setClient(t); setErrors((e) => ({ ...e, client: "" })); }}
          />
          {!!errors.client && <Text style={styles.errorText}>{errors.client}</Text>}
        </View>

        {/* JOB NUMBER. No `errors.jobNumber` and no inputError style, because
            there is nothing to be wrong: it is optional, it is free text, and
            it is not unique -- contractors reuse a job number across sites.

            `maxLength` comes off the shared constant rather than a literal, so
            the input stops at the same boundary the route refuses past.
            ci.sh's assert_job_number_cap_agrees proves the two are equal; them
            disagreeing is what produces "it won't save" with a message naming
            a limit the field did not enforce. */}
        <View style={styles.formGroup}>
          <Text style={styles.label}>Job Number</Text>
          <TextInput
            style={styles.input}
            placeholder="Optional — e.g. 2026-NW-00123"
            placeholderTextColor={Colors.textTertiary}
            value={jobNumber}
            onChangeText={setJobNumber}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={JOB_NUMBER_MAX_LENGTH}
            testID="create-site-job-number"
          />
        </View>

        {/* FILING. Drawn only for a manager or owner, and only when there is at
            least one client to file under — an empty picker on a screen a crew
            member should not have reached in the first place is two problems
            stacked, and the + button on the sites tab is not yet gated.

            The row is not an input: it opens ClientPicker, the same component
            app/site/[id].tsx opens, so filing looks identical in both places. */}
        {canFile && clients.length > 0 && (
          <View style={styles.formGroup}>
            <Text style={styles.label}>File under client</Text>
            <Pressable
              style={styles.dateRow}
              onPress={() => setShowClientPicker(true)}
              testID="create-site-client-filing"
            >
              <View style={styles.dateIconWrap}>
                <Ionicons name="briefcase-outline" size={18} color={Colors.accent} />
              </View>
              <View style={styles.dateTextWrap}>
                <Text style={styles.dateValue}>
                  {clients.find((c) => c.id === clientId)?.name ?? "Unfiled"}
                </Text>
                <Text style={styles.dateHint}>
                  {clientId ? "Tap to change" : "Optional — groups this site in the sites list"}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
            </Pressable>
          </View>
        )}

        <View style={styles.formGroup}>
          <Text style={styles.label}>Start Date</Text>
          <Pressable style={styles.dateRow} onPress={openDatePicker}>
            <View style={styles.dateIconWrap}>
              <Ionicons name="calendar-outline" size={18} color={Colors.accent} />
            </View>
            <View style={styles.dateTextWrap}>
              <Text style={styles.dateValue}>{formattedStartDate}</Text>
              <Text style={styles.dateHint}>Tap to change</Text>
            </View>
          </Pressable>
          {showDatePicker && Platform.OS !== "ios" && (
            <DateTimePicker
              value={new Date(`${startDate}T00:00:00`)}
              mode="date"
              display="default"
              onChange={handleDateChange}
            />
          )}
          {showDatePicker && Platform.OS === "ios" && (
            <Modal visible transparent animationType="fade" onRequestClose={() => setShowDatePicker(false)}>
              <View style={styles.modalBackdrop}>
                <View style={styles.modalCard}>
                  <Text style={styles.modalTitle}>Set Start Date</Text>
                  <Text style={styles.modalSelectedDate}>{formattedDraftDate}</Text>
                  <DateTimePicker
                    value={dateDraft}
                    mode="date"
                    display="spinner"
                    themeVariant="light"
                    textColor={Colors.text}
                    style={styles.modalDatePicker}
                    onChange={handleDateChange}
                  />
                  <View style={styles.modalActions}>
                    <Pressable style={styles.modalSecondary} onPress={() => setShowDatePicker(false)}>
                      <Text style={styles.modalSecondaryText}>Cancel</Text>
                    </Pressable>
                    <Pressable style={styles.modalPrimary} onPress={applyDateDraft}>
                      <Ionicons name="checkmark" size={18} color={Colors.white} />
                      <Text style={styles.modalPrimaryText}>Set Date</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </Modal>
          )}
        </View>

        <Pressable
          style={({ pressed }) => [styles.createButton, pressed && styles.createButtonPressed]}
          onPress={handleCreate}
          testID="create-site-submit"
        >
          <Ionicons name="checkmark" size={22} color={Colors.white} />
          <Text style={styles.createButtonText}>Create Site</Text>
        </Pressable>
      </ScrollView>

      {/* Outside the ScrollView: a Modal nested in a scrolling parent inherits
          its scroll offset on Android and opens part-way up the screen. */}
      <ClientPicker
        visible={showClientPicker}
        clients={clients}
        selectedClientId={clientId}
        onSelect={handleClientSelect}
        onClose={() => setShowClientPicker(false)}
        canManage={canFile}
        onManage={() => {
          setShowClientPicker(false);
          router.push("/clients");
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 20,
    gap: 20,
    paddingBottom: 40,
  },
  formGroup: {
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    marginLeft: 4,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    height: 52,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  inputError: {
    borderColor: Colors.error,
  },
  errorText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.error,
    marginLeft: 4,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
  },
  dateIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${Colors.accent}14`,
  },
  dateTextWrap: { flex: 1 },
  dateHint: {
    marginTop: 2,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
  },
  dateValue: {
    fontSize: 18,
    fontFamily: Platform.OS === "ios" ? "System" : "Inter_700Bold",
    fontWeight: Platform.OS === "ios" ? "700" : undefined,
    color: Colors.text,
  },
  addressLoadingText: {
    marginTop: 6,
    marginLeft: 4,
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  suggestionsCard: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    overflow: "hidden",
  },
  suggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  suggestionText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15,43,70,0.36)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  modalCard: {
    width: "100%",
    borderRadius: 16,
    backgroundColor: Colors.surface,
    padding: 14,
    gap: 8,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 4,
  },
  modalSelectedDate: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    textAlign: "center",
    marginTop: 2,
  },
  modalDatePicker: {
    backgroundColor: Colors.surface,
    height: 180,
  },
  modalSecondary: {
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  modalSecondaryText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textSecondary,
  },
  modalPrimary: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.accent,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  modalPrimaryText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  createButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.accent,
    height: 54,
    borderRadius: 14,
    marginTop: 8,
  },
  createButtonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  createButtonText: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
});
