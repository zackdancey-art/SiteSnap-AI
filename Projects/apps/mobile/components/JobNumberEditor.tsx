import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { JOB_NUMBER_MAX_LENGTH, normaliseJobNumber } from "@/lib/job-number";

/**
 * The job-number editor, opened from app/site/[id].tsx.
 *
 * Its own component rather than an inline modal on that screen for the same
 * reason as ClientPicker: the screen is already 900 lines and the two things
 * that matter here are easy to lose in it — that CLEARING is as ordinary as
 * setting (an empty field saves as "", which is how the API spells absence),
 * and that `maxLength` comes off the shared constant rather than a literal
 * typed here.
 *
 * WHY THE INPUT IS CAPPED AT ALL. The API refuses an over-long value with a
 * 400 rather than truncating it, so without the cap on the input a person
 * types a 60-character reference, presses Save, and is told their input is
 * invalid after the fact. `maxLength` stops them at the boundary instead.
 * ci.sh's assert_job_number_cap_agrees proves this number equals the one the
 * route enforces; the two tiers disagreeing is the failure that produces
 * exactly the "it won't save" symptom this exists to prevent.
 *
 * It holds the DRAFT and nothing else. The caller owns the write, which is
 * what lets it show "Saving…" and surface a refusal with describeFailure() the
 * way the filing control on the same screen does.
 */
export type JobNumberEditorProps = {
  visible: boolean;
  /** The value as stored. "" and undefined both mean no job number. */
  value: string | null | undefined;
  onSave: (jobNumber: string) => void;
  onClose: () => void;
  saving: boolean;
};

export function JobNumberEditor({ visible, value, onSave, onClose, saving }: JobNumberEditorProps) {
  const [draft, setDraft] = useState(() => normaliseJobNumber(value));

  /**
   * Re-seed the draft each time the modal OPENS, not on every `value` change.
   *
   * Keying on `visible` is deliberate: a re-seed while the modal is open would
   * discard what somebody is halfway through typing the moment a background
   * refresh() replaced the sites array. Closing and reopening is the only
   * gesture that resets it.
   */
  useEffect(() => {
    if (visible) setDraft(normaliseJobNumber(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const stored = normaliseJobNumber(value);
  const next = normaliseJobNumber(draft);
  const unchanged = next === stored;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The backdrop dismisses, as in ClientPicker: onRequestClose only covers
          the Android back button, and a modal whose only exit is a button is
          the shape that traps people. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Swallows the press so a tap on the card does not dismiss it. */}
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Job number</Text>
            <Pressable onPress={onClose} hitSlop={10} testID="job-number-close">
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </Pressable>
          </View>

          <Text style={styles.hint}>
            The contractor&apos;s own reference for this job. Optional, and it does not have to be
            unique — leave it empty to remove it.
          </Text>

          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. 2026-NW-00123"
            placeholderTextColor={Colors.textTertiary}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={JOB_NUMBER_MAX_LENGTH}
            editable={!saving}
            testID="job-number-input"
          />

          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              onPress={onClose}
              disabled={saving}
              testID="job-number-cancel"
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
            {/* Disabled when nothing changed, INCLUDING the case where the only
                difference is padding — `next` and `stored` are both trimmed,
                and the route trims too, so saving " A-1 " over "A-1" would be
                a request that changes nothing. */}
            <Pressable
              style={({ pressed }) => [
                styles.button,
                styles.buttonPrimary,
                pressed && styles.buttonPressed,
                (saving || unchanged) && styles.buttonDisabled,
              ]}
              onPress={() => onSave(next)}
              disabled={saving || unchanged}
              testID="job-number-save"
            >
              <Text style={[styles.buttonText, styles.buttonPrimaryText]}>
                {saving ? "Saving…" : next ? "Save" : "Remove"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    borderRadius: 16,
    backgroundColor: Colors.surface,
    padding: 16,
    gap: 12,
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
  hint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    lineHeight: 19,
  },
  input: {
    // 56 rather than 44, as in ClientPicker's rows: typed with a glove on, and
    // 44 is the floor rather than the target. AUDIT L51.
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.text,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
  },
  button: {
    flex: 1,
    minHeight: 52,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.background,
  },
  buttonPrimary: {
    backgroundColor: Colors.accent,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  buttonPrimaryText: {
    color: "#fff",
  },
});
