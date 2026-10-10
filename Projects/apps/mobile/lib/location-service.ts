import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBaseUrl } from "./api-base-url";
import { notifySessionExpired } from "./session";

const TRACKING_KEY = "sitesnap.locationTracking";
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let trackingInterval: ReturnType<typeof setInterval> | null = null;

export async function isLocationTrackingEnabled(): Promise<boolean> {
  const val = await AsyncStorage.getItem(TRACKING_KEY);
  return val === "true";
}

export async function setLocationTrackingEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(TRACKING_KEY, enabled ? "true" : "false");
  if (enabled) {
    startTracking();
  } else {
    stopTracking();
  }
}

async function sendLocation(lat: number, lng: number, accuracy?: number) {
  try {
    const token = await AsyncStorage.getItem("sitesnap.token");
    const userRaw = await AsyncStorage.getItem("sitesnap.user");
    const userName = userRaw ? (JSON.parse(userRaw) as { name?: string }).name : undefined;
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/api/location/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ latitude: lat, longitude: lng, accuracy, userName }),
    });
    // Background tracking is the one caller with nobody watching, so it stays
    // silent about its own failures - but it still knows the session is over,
    // and reporting that is not its own error. This is how a phone that has
    // been tracking for a week finds out, rather than posting to a 401 on a
    // loop until someone happens to open a feature screen.
    if (res.status === 401 && token) notifySessionExpired();
  } catch (err) {
    console.warn("[location-service] failed to send:", err);
  }
}

async function captureAndSend() {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== "granted") return;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await sendLocation(loc.coords.latitude, loc.coords.longitude, loc.coords.accuracy ?? undefined);
  } catch (err) {
    console.warn("[location-service] capture error:", err);
  }
}

export function startTracking() {
  if (trackingInterval) return;
  void captureAndSend(); // immediate first ping
  trackingInterval = setInterval(() => void captureAndSend(), INTERVAL_MS);
}

export function stopTracking() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
}

export async function requestPermissionAndStart(): Promise<boolean> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return false;
  await setLocationTrackingEnabled(true);
  return true;
}

export async function resumeTrackingIfEnabled() {
  const enabled = await isLocationTrackingEnabled();
  if (enabled) startTracking();
}
