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
 * CLASSIC TABS (older iOS, Android, web — the ClassicTabLayout branch)
 *
 * Here the bar IS a React view, so it is measured directly: (tabs)/_layout.tsx
 * attaches onLayout to the tabBarBackground view and publishes the height here.
 * That height already includes the bottom safe-area padding react-navigation
 * applies to the bar, so it is used INSTEAD of insets.bottom, never added to it.
 * (BottomTabBar gives its outer view `height: 49 + insets.bottom` AND
 * `paddingBottom: insets.bottom`, and an absolutely-positioned child with both
 * `top` and `bottom` set is sized to the border box, not the padding box — so
 * the measurement spans the padding rather than stopping short of it.)
 * This also covers web, where onLayout works under react-native-web — which is
 * why the `webBottomInset` constant is gone rather than relocated.
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
 * is what gets reported. The container really is a UIKit tab bar controller
 * (`RNSTabBarController : UITabBarController`) and the child really is a plain
 * `UIViewController` with no `additionalSafeAreaInsets` or
 * `viewSafeAreaInsetsDidChange` override anywhere in react-native-screens'
 * bottom-tabs sources, so nothing in the RN layer suppresses that accounting.
 *
 * WHY THE FALLBACK IS A FLOOR AND NOT A FALL-THROUGH
 *
 * Whether iOS 26 actually grows a tab child's safe area to clear the FLOATING
 * bar is the one thing here that source cannot settle, and there is no test
 * harness or device in the loop to settle it either. So this hook does not
 * assume it — it CHECKS it. The nested provider's bottom inset is compared
 * against the window's (captured by TabScreenInsets before nesting):
 *
 *   - grew  => UIKit is accounting for the bar; use the measured value.
 *   - equal => UIKit is not, and we have no measurement at all on this path.
 *
 * In that second case falling through to `insets.bottom` would reserve ~58pt
 * where the code being replaced reserved 100 — a REDUCTION, which would put the
 * last row of a list underneath the pill where it cannot be tapped. So the
 * legacy 100 is kept as an explicit floor for the not-measured case only. It is
 * still an unmeasured number, and it is still wrong by an unknown amount; the
 * difference is that it now over-reserves in a situation we have detected rather
 * than under-reserving in one we assumed away. A wrong bet costs dead space, not
 * unreachable content.
 *
 * The same floor covers the classic path's first frame, before onLayout lands —
 * the nested provider never renders null (it seeds from the parent's insets, see
 * SafeAreaContext.tsx `... ?? parentInsets ?? null`), but the measured height
 * does start at 0, and reserving too much for one frame beats hiding a row.
 */

/**
 * Pre-existing web chrome offset. Nine screens had this literal; this hook owns
 * the copies for the three (tabs) screens. The other six are untouched
 * (login, signup, forgot-password, reset-password, entry/[id], site/[id],
 * diary/[siteId]) because they are root-stack pushes with unrelated layouts —
 * centralising those is a separate change, not part of this one.
 */
const WEB_TOP_INSET = Platform.OS === "web" ? 67 : 0;

/**
 * The literal this hook replaced, retained ONLY as the floor described above:
 * used when the tab bar has not been measured, never in preference to a
 * measurement. See "WHY THE FALLBACK IS A FLOOR".
 */
const UNMEASURED_BAR_FALLBACK = 100;

/** Sub-pixel layout jitter below this is ignored rather than re-rendering. */
const LAYOUT_EPSILON = 0.5;

type TabBarState = {
  /** Measured height of the classic tab bar; 0 until its first onLayout. */
  classicHeight: number;
  /** True when ClassicTabLayout is the live layout (so a measurement is coming). */
  classicActive: boolean;
};

/**
 * Two contexts on purpose. The layout callback is stable for the life of the
 * provider, so (tabs)/_layout.tsx can subscribe to it WITHOUT also subscribing
 * to the height — otherwise every measurement would re-render the whole tab
 * navigator and hand <Tabs> a fresh screenOptions identity on each pass.
 */
const BarLayoutContext = createContext<(event: LayoutChangeEvent) => void>(() => {});

const BarStateContext = createContext<TabBarState>({
  classicHeight: 0,
  classicActive: false,
});

/**
 * The window's bottom inset, captured OUTSIDE the nested provider so that
 * useTabScreenInsets can tell a grown screen-local inset from an ungrown one.
 * null means no TabScreenInsets wrapper is present.
 */
const WindowBottomInsetContext = createContext<number | null>(null);

/**
 * Wraps the (tabs) layout so the classic bar's measured height reaches the
 * screens rendered inside it. `classicActive` tells the screens which mechanism
 * to expect, so the native path is never mistaken for an unmeasured classic one.
 */
export function ClassicTabBarProvider({
  classicActive,
  children,
}: {
  classicActive: boolean;
  children: React.ReactNode;
}) {
  const [classicHeight, setClassicHeight] = useState(0);

  const onBarLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    // Ignore sub-pixel jitter; a layout pass that reports 83.0001 must not
    // re-render every screen in the tab group.
    setClassicHeight((prev) => (Math.abs(prev - next) < LAYOUT_EPSILON ? prev : next));
  }, []);

  const state = useMemo(
    () => ({ classicHeight, classicActive }),
    [classicHeight, classicActive]
  );

  return (
    <BarLayoutContext.Provider value={onBarLayout}>
      <BarStateContext.Provider value={state}>{children}</BarStateContext.Provider>
    </BarLayoutContext.Provider>
  );
}

/**
 * Used by (tabs)/_layout.tsx to attach onLayout to the classic tab bar. Returns
 * only the callback, deliberately — see the note on the two contexts above.
 */
export function useClassicTabBarLayout(): (event: LayoutChangeEvent) => void {
  return useContext(BarLayoutContext);
}

/**
 * Wrap the root of a screen inside the (tabs) group. Nests a SafeAreaProvider so
 * that useTabScreenInsets() below reads the screen's own safe area rather than
 * the window's, and publishes the window's bottom inset so the two can be
 * compared. Without this wrapper the hook still returns usable values — it just
 * cannot see a native tab bar, and falls back to the floor.
 */
export function TabScreenInsets({ children }: { children: React.ReactNode }) {
  const windowInsets = useSafeAreaInsets();
  return (
    <WindowBottomInsetContext.Provider value={windowInsets.bottom}>
      <SafeAreaProvider style={{ flex: 1 }}>{children}</SafeAreaProvider>
    </WindowBottomInsetContext.Provider>
  );
}

/**
 * Top and bottom padding for a screen inside the (tabs) group.
 *
 * `top` clears the status bar (and the web chrome). `bottom` clears the tab bar
 * and the home indicator. Must be called under a TabScreenInsets wrapper.
 */
export function useTabScreenInsets(): { top: number; bottom: number } {
  const insets = useSafeAreaInsets();
  const { classicHeight, classicActive } = useContext(BarStateContext);
  const windowBottom = useContext(WindowBottomInsetContext);

  return useMemo(() => {
    let bottom: number;

    if (classicActive) {
      // Measured React view. Its height already contains the bottom safe-area
      // padding, so the two are alternatives, not addends.
      bottom = classicHeight > 0 ? classicHeight : UNMEASURED_BAR_FALLBACK;
    } else if (windowBottom !== null && insets.bottom > windowBottom + LAYOUT_EPSILON) {
      // Native path, and the screen-local inset is larger than the window's:
      // UIKit has grown it to clear the bar, which is the measurement.
      bottom = insets.bottom;
    } else {
      // Native path with an ungrown inset (or no wrapper at all): nothing has
      // been measured, so over-reserve rather than hide a row.
      bottom = UNMEASURED_BAR_FALLBACK;
    }

    return { top: insets.top + WEB_TOP_INSET, bottom };
  }, [insets.top, insets.bottom, classicHeight, classicActive, windowBottom]);
}
