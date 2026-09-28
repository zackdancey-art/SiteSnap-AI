import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Colors from "@/constants/colors";

/**
 * One row in a Settings card: icon, label, optional description, and either a
 * trailing value or a drill-down chevron.
 *
 * Extracted from app/(tabs)/settings.tsx when Settings was split into a
 * drill-down (Account / Data & Privacy / About each got their own screen) so
 * that the row, and the divider that separates rows, are defined once rather
 * than copied into each detail screen.
 *
 * The original had a `toggle` / `toggleValue` / `onToggle` Switch variant that
 * no call site ever used; it is not carried over. Add it back when a real
 * toggle setting exists, not before.
 */
export interface SettingsRowProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  /** Trailing read-only value. Suppresses the drill-down chevron. */
  value?: string;
  onPress?: () => void;
  /** Destructive action — red icon wash and red label (Sign Out, Delete Account). */
  danger?: boolean;
}

export function SettingsRow({ icon, label, description, value, onPress, danger }: SettingsRowProps) {
  const content = (
    <View style={styles.settingRow}>
      <View style={[styles.settingIcon, danger && { backgroundColor: Colors.error + "14" }]}>
        <Ionicons name={icon} size={20} color={danger ? Colors.error : Colors.accent} />
      </View>
      <View style={styles.settingLabelCol}>
        <Text style={[styles.settingLabelText, danger && { color: Colors.error }]}>{label}</Text>
        {!!description && <Text style={styles.settingDescription}>{description}</Text>}
      </View>
      {!!value && <Text style={styles.settingValue}>{value}</Text>}
      {!value && !!onPress && <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />}
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: 0.7 }}>
        {content}
      </Pressable>
    );
  }
  return content;
}

/** Divider between two rows — inset to start under the label, clearing the icon. */
export function SettingsDivider() {
  return <View style={styles.divider} />;
}

/** Full-bleed divider, for separating prose blocks rather than rows. */
export function SettingsDividerFull() {
  return <View style={styles.dividerFull} />;
}

const styles = StyleSheet.create({
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
  },
  settingLabelCol: {
    flex: 1,
    gap: 2,
  },
  settingLabelText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.text,
  },
  settingDescription: {
    fontSize: 12.5,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    lineHeight: 17,
  },
  settingValue: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textTertiary,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.borderLight,
    marginLeft: 64,
  },
  dividerFull: {
    height: 1,
    backgroundColor: Colors.borderLight,
  },
});
