import React from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Colors from "@/constants/colors";

/**
 * The section shell used by the Settings screen and its detail screens: an
 * accent-barred uppercase heading, an optional one-line description, and one or
 * more rounded cards holding rows or prose.
 *
 * Extracted alongside SettingsRow when Settings became a drill-down, so the
 * four screens share one definition instead of four copies of the same
 * stylesheet.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  /** Omitted for an ungrouped card, e.g. the Sign Out / Delete Account pair. */
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      {!!title && <Text style={styles.sectionTitle}>{title}</Text>}
      {!!description && <Text style={styles.sectionDesc}>{description}</Text>}
      {children}
    </View>
  );
}

export function SettingsCard({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.sectionCard, style]}>{children}</View>;
}

/** A paragraph of explanatory copy inside a card. */
export function SettingsBody({ children }: { children: React.ReactNode }) {
  return <Text style={styles.cardBody}>{children}</Text>;
}

/** Lead-in emphasis at the start of a SettingsBody paragraph. */
export function SettingsBodyStrong({ children }: { children: React.ReactNode }) {
  return <Text style={styles.cardBodyStrong}>{children}</Text>;
}

const styles = StyleSheet.create({
  section: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderLeftColor: Colors.accent,
  },
  sectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    overflow: "hidden",
  },
  sectionDesc: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 19,
    marginTop: -2,
    marginBottom: 10,
    paddingLeft: 2,
  },
  cardBody: {
    fontSize: 14,
    color: Colors.text,
    lineHeight: 21,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  cardBodyStrong: {
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
});
