import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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
 * put "Dashboard" 16pt from the physical top of the display, under
 * the status bar, on both the normal and the Access Restricted branch. It is the
 * only screen in the app with that fault — the other two tab screens size their
 * own headers off the top inset, the seven pushed screens get it from the shared
 * ScreenHeader, and the eight native-header screens get it from the OS.
 *
 * It is also inside the (tabs) group, so it needs the bottom inset for the tab
 * bar like the other two. Both insets go on the existing View container. The
 * content is short and does not reach the bottom today, and this screen is being
 * rebuilt on the mobile dashboard parity branch, which brings the ScrollView it
 * actually needs along with pull-to-refresh and loading/error states. Converting
 * it here would be throwaway work and a merge conflict surface for no benefit.
 *
 * useTabScreenInsets() is the contract for that rebuild: the ScrollView
 * conversion belongs there, and it consumes these same two values unchanged —
 * `top` on the header, `bottom` on contentContainerStyle instead of the View.
 */
function SupervisorContent() {
  const insets = useTabScreenInsets();
  const { sites, entries, diaries } = useData();
  const { user } = useAuth();
  const canSeeSupervisor = user?.companyRole === "owner" || user?.companyRole === "manager";

  // The original 16pt gutter, with each inset added to the edge that needs it.
  // Bottom clears the tab bar, which does not contribute to layout, so the
  // button stays reachable if the metric list grows before the rebuild lands.
  const containerStyle = [
    styles.container,
    { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
  ];

  if (!canSeeSupervisor) {
    return (
      <View style={containerStyle}>
        <Text style={styles.title}>Access Restricted</Text>
        <Text style={styles.subtitle}>Owner and manager accounts only.</Text>
      </View>
    );
  }

  return (
    <View style={containerStyle}>
      <Text style={styles.title}>Dashboard</Text>
      <Text style={styles.subtitle}>Monitor project activity and report readiness.</Text>
      <View style={styles.card}>
        <Text style={styles.metric}>Sites: {sites.length}</Text>
        <Text style={styles.metric}>Entries: {entries.length}</Text>
        <Text style={styles.metric}>Diaries: {diaries.length}</Text>
      </View>
      <Pressable style={styles.button} onPress={() => router.push("/supervisor-dashboard")}>
        <Text style={styles.buttonText}>Open Full Dashboard</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background, paddingHorizontal: 16, gap: 12 },
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
