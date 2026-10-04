import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { Ionicons, Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useData } from "@/lib/data-context";
import { SyncStatusBanner } from "@/components/SyncStatusBanner";
import Colors from "@/constants/colors";
import { Site } from "@/lib/types";
import { TabScreenInsets, useTabScreenInsets } from "@/lib/useScreenInsets";

function SiteCard({ site }: { site: Site }) {
  const entryCount = useData().entries.filter((e) => e.siteId === site.id).length;

  const statusColor =
    site.status === "active" ? Colors.success : site.status === "on-hold" ? Colors.warning : Colors.textTertiary;
  const statusLabel = site.status === "on-hold" ? "On Hold" : site.status.charAt(0).toUpperCase() + site.status.slice(1);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => router.push({ pathname: "/site/[id]", params: { id: site.id } })}
      testID={`site-card-${site.id}`}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardIcon}>
          <Ionicons name="business" size={22} color={Colors.accent} />
        </View>
        <View style={styles.cardHeaderText}>
          <Text style={styles.cardTitle} numberOfLines={1}>{site.name}</Text>
          <Text style={styles.cardClient} numberOfLines={1}>{site.client}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + "18" }]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      <View style={styles.cardBody}>
        <View style={styles.cardDetail}>
          <Ionicons name="location-outline" size={14} color={Colors.textTertiary} />
          <Text style={styles.cardDetailText} numberOfLines={1}>{site.address}</Text>
        </View>
        <View style={styles.cardFooter}>
          <View style={styles.cardDetail}>
            <Ionicons name="calendar-outline" size={14} color={Colors.textTertiary} />
            <Text style={styles.cardDetailText}>
              {new Date(site.startDate).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
            </Text>
          </View>
          <View style={styles.cardDetail}>
            <Ionicons name="document-text-outline" size={14} color={Colors.textTertiary} />
            <Text style={styles.cardDetailText}>{entryCount} {entryCount === 1 ? "entry" : "entries"}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export default function SitesScreen() {
  return (
    <TabScreenInsets>
      <SitesContent />
    </TabScreenInsets>
  );
}

function SitesContent() {
  const insets = useTabScreenInsets();
  const { sites } = useData();
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return sites;
    const q = search.toLowerCase();
    return sites.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.client.toLowerCase().includes(q) ||
        s.address.toLowerCase().includes(q)
    );
  }, [sites, search]);

  const onRefresh = () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  };

  const activeSites = filtered.filter((s) => s.status === "active").length;

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.headerTitle}>My Sites</Text>
            <Text style={styles.headerSubtitle}>{activeSites} active {activeSites === 1 ? "project" : "projects"}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.addButton, pressed && { opacity: 0.85 }]}
            onPress={() => router.push("/create-site")}
            testID="add-site-button"
          >
            <Ionicons name="add" size={24} color={Colors.white} />
          </Pressable>
        </View>

        <View style={styles.searchContainer}>
          <Feather name="search" size={18} color={Colors.textTertiary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search sites..."
            placeholderTextColor={Colors.textTertiary}
            value={search}
            onChangeText={setSearch}
          />
          {!!search && (
            <Pressable onPress={() => setSearch("")}>
              <Ionicons name="close-circle" size={18} color={Colors.textTertiary} />
            </Pressable>
          )}
        </View>
      </View>

      <SyncStatusBanner />

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <SiteCard site={item} />}
        // insets.bottom clears the tab bar (measured, see lib/useScreenInsets);
        // the +24 is breathing room below the last card, not a guess at the bar.
        contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent} />}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="business-outline" size={56} color={Colors.textTertiary} />
            <Text style={styles.emptyTitle}>{search ? "No sites found" : "No sites yet"}</Text>
            <Text style={styles.emptyText}>
              {search ? "Try adjusting your search" : "Tap the + button to create your first site"}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    color: Colors.white,
  },
  headerSubtitle: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
  },
  addButton: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 14,
    paddingHorizontal: 14,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    height: 44,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.white,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
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
  cardPressed: {
    opacity: 0.95,
    transform: [{ scale: 0.99 }],
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.accent + "14",
    alignItems: "center",
    justifyContent: "center",
  },
  cardHeaderText: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  cardClient: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    marginTop: 1,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  cardBody: {
    gap: 8,
  },
  cardDetail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  cardDetailText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    flex: 1,
  },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    textAlign: "center",
    paddingHorizontal: 40,
  },
});
