/**
 * What the app says when the camera is refused, and whether Settings is the
 * route out.
 *
 * SEPARATE FROM `camera-access.ts` for the reason `photo-capture-time.ts` is
 * separate from `photo-capture.ts`: that module imports `Alert` and `Linking`
 * from react-native, which `node --test` cannot load. The decision being made
 * here — which of two situations the user is in, and therefore what they are
 * told to do — is exactly the part that should not rest on a device pass and a
 * careful read.
 *
 * Nothing here may import React Native or expo. `tsconfig.test.json` lists this
 * file explicitly and the compile fails loudly if that changes.
 */

export type CameraRefusal = {
  title: string;
  message: string;
  /**
   * Whether to offer a button into the OS settings page for this app.
   *
   * Offered only when the system will NOT prompt again. Sending someone to
   * Settings when tapping the button a second time would have worked is its own
   * dead end, just a politer one.
   */
  offerSettings: boolean;
};

/**
 * `canAskAgain` is the whole decision.
 *
 * On iOS the camera prompt is shown ONCE per install. After a single "Don't
 * Allow" the OS answers every later request immediately with denied and
 * `canAskAgain: false`, and no amount of asking from inside the app will ever
 * show that prompt again — the only route back is Settings. So a builder who
 * taps "no" once is, without this, permanently unable to photograph a site and
 * is told only "Camera access is needed to take photos", which is true and
 * useless.
 *
 * `canAskAgain: true` is the other case: the prompt was dismissed rather than
 * refused, or this is Android where a plain deny is retryable. There the honest
 * instruction is to tap the button again, not to go hunting in Settings.
 */
export function describeCameraRefusal(canAskAgain: boolean): CameraRefusal {
  if (canAskAgain) {
    return {
      title: "Camera not allowed yet",
      message:
        "SiteSnap needs the camera to photograph the site. Tap Take Photo again and choose Allow.",
      offerSettings: false,
    };
  }

  return {
    title: "Camera access is turned off",
    message:
      "SiteSnap cannot open the camera because camera access is switched off for this app, and your phone will not ask again. Turn it back on in Settings, then come back and take the photo. You can still add a photograph from your library in the meantime.",
    offerSettings: true,
  };
}
