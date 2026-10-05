import { Alert, Linking, type AlertButton } from "react-native";
import type * as ImagePicker from "expo-image-picker";

import { describeCameraRefusal } from "./camera-permission";

/**
 * One place that asks for the camera and says something useful when refused.
 *
 * Both capture screens — `app/new-entry.tsx` and `app/inspections/[siteId].tsx`
 * — had the same four lines:
 *
 *     if (!result.granted) {
 *       Alert.alert("Permission Required", "Camera access is needed to take photos.");
 *       return;
 *     }
 *
 * which is a dead end on iOS. The prompt is shown once per install; after one
 * "Don't Allow" the OS refuses every later request without asking, so that
 * alert repeats forever and names nothing the user can do. `canAskAgain` says
 * which case it is and `describeCameraRefusal` turns that into words; this adds
 * the route out.
 *
 * `Linking.openSettings()` opens the OS settings page for THIS app on both
 * platforms. It is deliberately not `openURL("app-settings:")` — that is an
 * iOS-only scheme and Apple has rejected apps for hand-rolling it.
 */
export async function ensureCameraAccess(
  current: ImagePicker.PermissionResponse | null,
  request: () => Promise<ImagePicker.PermissionResponse>
): Promise<boolean> {
  if (current?.granted) return true;

  const result = await request();
  if (result.granted) return true;

  const refusal = describeCameraRefusal(result.canAskAgain);
  const buttons: AlertButton[] = refusal.offerSettings
    ? [
        { text: "Not now", style: "cancel" },
        {
          text: "Open Settings",
          onPress: () => {
            void Linking.openSettings();
          },
        },
      ]
    : [{ text: "OK" }];

  Alert.alert(refusal.title, refusal.message, buttons);
  return false;
}
