import React from "react";
import { StyleSheet, View } from "react-native";
import { ScreenHeader } from "@/components/ScreenHeader";
import { ClientsView } from "@/components/ClientsView";
import { useData } from "@/lib/data-context";
import Colors from "@/constants/colors";

/**
 * The Clients ROUTE. Chrome only — the list, the forms and every rule about
 * them are in components/ClientsView.tsx, which the Sites tab renders too.
 *
 * WHY THE ROUTE STILL EXISTS, now that Clients is a view of the Sites screen:
 *
 *   - "Manage clients" in the client picker pushes to it
 *     (app/create-site.tsx:352, app/site/[id].tsx:540). That footer is a
 *     picker affordance, not a navigation menu, and sending it to a tab would
 *     drop whatever the person was half-way through creating.
 *   - `screen-header-audit.test.ts` pins `clients` as a route that renders
 *     <ScreenHeader> and is registered with the native header hidden. Deleting
 *     the route would fail that guard by name, which is what it is for.
 *
 * `homeFallback` is the Sites tab rather than Settings: the Clients row has
 * left Settings, so the back affordance may not point at a screen that no
 * longer offers this one.
 */
export default function ClientsScreen() {
  const { clients } = useData();

  return (
    <View style={styles.container}>
      <ScreenHeader
        title="Clients"
        subtitle={`${clients.length} ${clients.length === 1 ? "client" : "clients"}`}
        homeFallback="/(tabs)"
      />
      <ClientsView />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
});
