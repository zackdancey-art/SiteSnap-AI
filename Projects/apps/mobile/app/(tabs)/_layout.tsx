import { isLiquidGlassAvailable } from "expo-glass-effect";
import { Tabs } from "expo-router";
import { NativeTabs, Icon, Label } from "expo-router/unstable-native-tabs";
import { Platform, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import React from "react";
import Colors from "@/constants/colors";
import { useAuth } from "@/lib/auth-context";
import { ClassicTabBarProvider, useClassicTabBarLayout } from "@/lib/useScreenInsets";
import { canSeeSupervisorDashboard } from "@/lib/permissions";

function NativeTabLayout({ canSeeSupervisor }: { canSeeSupervisor: boolean }) {
  return (
    <NativeTabs backgroundColor={Colors.primary} tintColor={Colors.accent}>
      <NativeTabs.Trigger name="index">
        <Icon sf={{ default: "building.2", selected: "building.2.fill" }} />
        <Label>Sites</Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
        <Label>Settings</Label>
      </NativeTabs.Trigger>
      {canSeeSupervisor && (
        <NativeTabs.Trigger name="supervisor">
          <Icon sf={{ default: "chart.bar", selected: "chart.bar.fill" }} />
          <Label>Dashboard</Label>
        </NativeTabs.Trigger>
      )}
    </NativeTabs>
  );
}

function ClassicTabLayout({ canSeeSupervisor }: { canSeeSupervisor: boolean }) {
  const isWeb = Platform.OS === "web";
  const isIOS = Platform.OS === "ios";
  const onBarLayout = useClassicTabBarLayout();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.onPrimaryMuted,
        tabBarLabelStyle: {
          fontFamily: "Inter_500Medium",
          fontSize: 11,
        },
        // Navy-forward chrome: solid brand navy tab bar on every platform (was
        // a light/translucent bar). Active tab = orange, inactive = muted white.
        tabBarStyle: {
          position: "absolute",
          backgroundColor: Colors.primary,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: Colors.onPrimaryBorder,
          elevation: 0,
          // Pre-existing, and the one tab-bar height literal left in the tree.
          // It is not a guess used as padding: getTabBarHeight() returns it as
          // the bar's customHeight, and the onLayout below then MEASURES that
          // same 84, so the reserved space still comes from a measurement.
          ...(isWeb ? { height: 84 } : {}),
        },
        // onLayout here is the ONLY runtime measurement of the classic tab bar
        // available to the screens inside it (see lib/useScreenInsets.tsx), so
        // the view is rendered on every platform — Android included — and the
        // brand fill is applied on iOS/web only, as before.
        //
        // Android subtlety: returning non-null from tabBarBackground flips
        // BottomTabBar's own `backgroundColor` from `colors.card` to
        // `transparent`. Nothing changes visually ONLY because tabBarStyle above
        // sets backgroundColor: Colors.primary and is applied after it. If that
        // is ever removed (e.g. moving to a blur or gradient), give this view an
        // explicit Android fill or the bar goes see-through, with content
        // scrolling behind the labels.
        tabBarBackground: () => (
          <View
            onLayout={onBarLayout}
            style={[StyleSheet.absoluteFill, (isIOS || isWeb) && { backgroundColor: Colors.primary }]}
          />
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Sites",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="business" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-outline" size={size} color={color} />
          ),
        }}
      />
      {/*
        `Tabs.Protected`, NOT `{canSeeSupervisor && <Tabs.Screen …>}`.

        The conditional that was here did not hide anything. expo-router builds a
        navigator's screen list from the FILE SYSTEM and uses the `Tabs.Screen`
        children only to order and configure it: useSortedScreens() ends with
        `ordered.push(...entries)` — "Add any remaining children" — so a route
        with no matching child is appended with default options rather than
        dropped. `withLayoutContext(BottomTabNavigator, …)` passes no third
        argument, leaving `useOnlyUserDefinedScreens` false, so for the CLASSIC
        tab bar — Android, web, and any iOS without Liquid Glass — a crew member
        got a tab labelled "supervisor" with no icon, leading to the Access
        Restricted screen. Removing the configuration removed the label and the
        icon, which is why it looked like it worked.

        `Protected` is the mechanism that removes a screen: a guard that is false
        puts the route into `protectedScreens`, which useSortedScreens filters
        unconditionally. So there is no tab, and `/(tabs)/supervisor` does not
        resolve either — which is the half a hidden button never gives you.

        The NativeTabs branch above is left as a conditional on purpose: that
        navigator IS built with `useOnlyUserDefinedScreens: true`
        (NativeBottomTabsNavigator.js), so omitting a Trigger genuinely drops the
        route there. The two branches differ because expo-router differs.
      */}
      <Tabs.Protected guard={canSeeSupervisor}>
        <Tabs.Screen
          name="supervisor"
          options={{
            title: "Dashboard",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="bar-chart-outline" size={size} color={color} />
            ),
          }}
        />
      </Tabs.Protected>
    </Tabs>
  );
}

export default function TabLayout() {
  const { user } = useAuth();
  const canSeeSupervisor = canSeeSupervisorDashboard(user?.companyRole);
  // Which branch is live decides which measurement the screens inside should
  // wait for, so it is published rather than re-derived per screen.
  const useNativeTabs = isLiquidGlassAvailable();
  return (
    <ClassicTabBarProvider classicActive={!useNativeTabs}>
      {useNativeTabs ? (
        <NativeTabLayout canSeeSupervisor={canSeeSupervisor} />
      ) : (
        <ClassicTabLayout canSeeSupervisor={canSeeSupervisor} />
      )}
    </ClassicTabBarProvider>
  );
}
