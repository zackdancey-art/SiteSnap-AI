import { QueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { resolveApiBaseUrl } from "@/lib/api-base-url";
import { notifySessionExpired } from "@/lib/session";

export const BASE_URL =
  resolveApiBaseUrl();

/**
 * Returns the raw Response on purpose: every caller reads the body itself, and
 * several are the pre-authentication screens (signup, forgot-password,
 * reset-password) where a non-2xx is ordinary and must stay theirs to report.
 *
 * The 401 branch is therefore conditional on having sent a token. Registering
 * an account can draw a 401 from a wrong verification code while the app is,
 * correctly, signed out; routing that to the sign-in screen saying the session
 * expired would be a worse error than the one being fixed.
 */
export async function apiRequest(method: string, path: string, body?: unknown) {
  const url = `${BASE_URL}${path}`;
  const token = await AsyncStorage.getItem("sitesnap.token");
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) notifySessionExpired();
  return res;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
});
