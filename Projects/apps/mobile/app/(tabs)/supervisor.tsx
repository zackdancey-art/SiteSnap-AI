import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import { TabScreenInsets, useTabScreenInsets } from "@/lib/useScreenInsets";
import Colors from "@/constants/colors";

export default function SupervisorTabScreen() {
  return (
    <TabScreenInsets>
      <SupervisorContent />
    </TabScreenInsets>
  );
}

/**
 * This screen had no safe-area handling at all: a bare `padding: 16` container
 * put "Supervisor Dashboard" 16pt from the physical top of the display, under
 * the status bar, on both the normal and the Access Restricted branch. It is the
 * only screen in the app with that fault — the other two tab screens size their
 * own headers off the top inset, the seven pushed screens get it from the shared
 * ScreenHeader, and the eight native-header screens get it from the OS.
 *
 * It is also inside the (tabs) group, so it needs the bottom inset for the tab
 * bar like the other two. The content is short enough to fit today, but it grows
 * with the number of metrics, so it scrolls rather than relying on that.
 */
function SupervisorContent() {
  const insets = useTabScreenInsets();
  const { sites, entries, diaries } = useData();
  const { user } = useAuth();
  const canSeeSupervisor = user?.companyRole === "owner" || user?.companyRole === "manager";

  const contentStyle = [
    styles.content,
    { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 },
  ];

  if (!canSeeSupervisor) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={contentStyle}>
        <Text style={styles.title}>Access Restricted</Text>
        <Text style={styles.subtitle}>Supervisor dashboard is only visible for assigned supervisor accounts.</Text>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={contentStyle}>
      <Text style={styles.title}>Supervisor Dashboard</Text>
      <Text style={styles.subtitle}>Monitor project activity and report readiness.</Text>
      <View style={styles.card}>
        <Text style={styles.metric}>Sites: {sites.length}</Text>
        <Text style={styles.metric}>Entries: {entries.length}</Text>
        <Text style={styles.metric}>Diaries: {diaries.length}</Text>
      </View>
      <Pressable style={styles.button} onPress={() => router.push("/supervisor-dashboard")}>
        <Text style={styles.buttonText}>Open Full Dashboard</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { paddingHorizontal: 16, gap: 12 },
  title: { fontSize: 24, fontFamily: "Inter_700Bold", color: Colors.text },
  subtitle: { fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.textSecondary },
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  metric: { fontSize: 15, fontFamily: "Inter_500Medium", color: Colors.text },
  button: {
    backgroundColor: Colors.accent,
    borderRadius: 12,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: Colors.white, fontSize: 14, fontFamily: "Inter_600SemiBold" },
});
