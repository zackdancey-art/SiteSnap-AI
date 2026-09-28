import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Platform, type LayoutChangeEvent } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Safe-area insets for the three screens that live INSIDE the (tabs) group —
 * (tabs)/index, (tabs)/settings and (tabs)/supervisor.
 *
 * WHY THESE SCREENS ARE SPECIAL
 *
 * The tab bar does not contribute to layout. On the classic layout it is
 * `position: "absolute"`; on the native layout it is a UIKit tab bar floating
 * over the content. Either way a scroll container inside a tab has to reserve
 * the space itself, and every other route in the app is a root-stack push that
 * covers the tab bar entirely and needs none of this.
 *
 * It was reserved with a literal `100` (plus `Platform.OS === "web" ? 34 : 0`)
 * copied into each screen. Nobody measured 100 against anything; it is wrong by
 * an unknown amount on every device, and the supervisor screen had no bottom
 * handling at all. This hook replaces the constant with a value measured at
 * runtime, by two different mechanisms because the two tab layouts expose the
 * bar in two different ways.
 *
 * NATIVE TABS (iOS 26+, isLiquidGlassAvailable() — the liquid-glass pill)
 *
 * There is nothing in JS to measure: `expo-router/build/native-tabs` contains no
 * onLayout, no measure() and no tabBarHeight, because NativeTabs.Trigger/Icon/
 * Label are configuration rather than views, and the bar itself is a
 * UITabBarController. react-native-screens does not surface its height either.
 *
 * So the measurement comes from UIKit instead. react-native-safe-area-context's
 * provider reports the safe-area insets of ITS OWN native view
 * (RNCSafeAreaProvider.m reads `self.safeAreaInsets`), and expo-router mounts
 * the only provider at the very root — above the tabs — which is why today's
 * `useSafeAreaInsets().bottom` sees the home indicator and not the bar.
 * TabScreenInsets nests a second provider INSIDE the screen, so its view sits
 * within the tab bar controller's child and UIKit's own accounting for the bar
 * is what gets reported.
 *
 * CLASSIC TABS (everything else: older iOS, Android, web)
 *
 * Here the bar IS a React view, so it is measured directly: (tabs)/_layout.tsx
 * attaches onLayout to the tabBarBackground view and publishes the height here.
 * That height already includes the bottom safe-area padding react-navigation
 * applies to the bar, so it is used INSTEAD of insets.bottom, never added to it.
 * This also covers web, where onLayout works under react-native-web — which is
 * why the `webBottomInset` constant is gone rather than relocated.
 *
 * HOW IT DEGRADES
 *
 * A nested SafeAreaProvider seeds its state from the parent's insets
 * (SafeAreaContext.tsx: `initialMetrics?.insets ?? initialSafeAreaInsets ??
 * parentInsets ?? null`), so it renders its children on the first frame with the
 * window values and refines them once its own view is laid out. It never renders
 * null and never flashes. If UIKit turned out not to include the floating bar in
 * the child's safe area, the value stays at the window's bottom inset — the
 * present behaviour — rather than becoming a new kind of wrong.
 */

/** Pre-existing web chrome offset, previously duplicated in two screens. */
const WEB_TOP_INSET = Platform.OS === "web" ? 67 : 0;

type ClassicTabBarMeasurement = {
  /** Measured height of the classic tab bar, or 0 when it is not the live layout. */
  height: number;
  onBarLayout: (event: LayoutChangeEvent) => void;
};

const ClassicTabBarContext = createContext<ClassicTabBarMeasurement>({
  height: 0,
  onBarLayout: () => {},
});

/**
 * Wraps the (tabs) layout so the classic bar's measured height reaches the
 * screens rendered inside it. Provides 0 under NativeTabs, which never calls
 * onBarLayout — that branch falls through to the nested-provider measurement.
 */
export function ClassicTabBarProvider({ children }: { children: React.ReactNode }) {
  const [height, setHeight] = useState(0);

  const onBarLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    // Ignore sub-pixel jitter; a layout pass that reports 812.0001 must not
    // re-render every screen in the tab group.
    setHeight((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
  }, []);

  const value = useMemo(() => ({ height, onBarLayout }), [height, onBarLayout]);
  return <ClassicTabBarContext.Provider value={value}>{children}</ClassicTabBarContext.Provider>;
}

/** Used by (tabs)/_layout.tsx to attach onLayout to the classic tab bar. */
export function useClassicTabBarMeasurement(): ClassicTabBarMeasurement {
  return useContext(ClassicTabBarContext);
}

/**
 * Wrap the root of a screen inside the (tabs) group. Nests a SafeAreaProvider so
 * that useTabScreenInsets() below reads the screen's own safe area rather than
 * the window's. Without this wrapper the hook still returns usable values — it
 * just cannot see a native tab bar.
 */
export function TabScreenInsets({ children }: { children: React.ReactNode }) {
  return <SafeAreaProvider style={{ flex: 1 }}>{children}</SafeAreaProvider>;
}

/**
 * Top and bottom padding for a screen inside the (tabs) group.
 *
 * `top` clears the status bar (and the web chrome). `bottom` clears the tab bar
 * and the home indicator. Must be called under a TabScreenInsets wrapper.
 */
export function useTabScreenInsets(): { top: number; bottom: number } {
  const insets = useSafeAreaInsets();
  const { height: classicBarHeight } = useClassicTabBarMeasurement();

  return useMemo(
    () => ({
      top: insets.top + WEB_TOP_INSET,
      // The classic bar's measured height already contains the bottom safe-area
      // padding react-navigation puts inside it, so the two are alternatives,
      // not addends. Under NativeTabs the height is 0 and insets.bottom is the
      // screen-local inset, which UIKit has already grown to clear the bar.
      bottom: classicBarHeight > 0 ? classicBarHeight : insets.bottom,
    }),
    [insets.top, insets.bottom, classicBarHeight]
  );
}
