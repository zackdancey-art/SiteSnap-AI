import { useCallback, useEffect, useRef } from "react";
import { Alert } from "react-native";
import { useNavigation } from "expo-router";

/**
 * Guards a form screen against losing unsaved changes.
 *
 * While `isDirty` is true it (1) disables the iOS modal swipe-dismiss gesture —
 * a guard with a swipe bypass is not a guard — and (2) intercepts every removal
 * (Android hardware-back, the native header close, programmatic `router.back()`)
 * with a "Discard changes?" confirmation.
 *
 * Returns `markSaved`: call it immediately before navigating away on a
 * successful save so the guard lets that programmatic exit through without a
 * spurious discard prompt (the form state is still "dirty" at that point — no
 * React render can flush between the save and the synchronous `router.back()`).
 *
 * `markSaved` is ONLY for that save-then-leave sequence. A screen that saves and
 * STAYS mounted must not call it: it does not need to (clearing the form makes
 * `isDirty` false on the next render, which is enough), and the latch it sets
 * would otherwise suppress the guard for the rest of the screen's life. The
 * latch therefore re-arms below whenever the form goes clean again, so a misuse
 * degrades to one unguarded exit rather than a permanently disarmed screen.
 */
export function useUnsavedChangesGuard(isDirty: boolean): () => void {
  const navigation = useNavigation();
  const savedRef = useRef(false);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !isDirty });
  }, [isDirty, navigation]);

  // Re-arm once the form is clean. The save-then-leave callers never reach this
  // (they unmount while still dirty), so it cannot let their exit be prompted.
  useEffect(() => {
    if (!isDirty) savedRef.current = false;
  }, [isDirty]);

  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (!isDirty || savedRef.current) return;
      e.preventDefault();
      Alert.alert(
        "Discard changes?",
        "You have unsaved changes. Discard them?",
        [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.dispatch(e.data.action),
          },
        ]
      );
    });
    return unsubscribe;
  }, [isDirty, navigation]);

  return useCallback(() => {
    savedRef.current = true;
  }, []);
}
