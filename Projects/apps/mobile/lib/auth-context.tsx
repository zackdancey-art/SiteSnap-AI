import React, { createContext, useContext, useState, useEffect } from "react";
import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { resolveApiBaseUrl } from "@/lib/api-base-url";
import {
  SessionExpiredError,
  clearSessionExpired,
  notifySessionExpired,
  setSessionExpiredHandler,
} from "@/lib/session";

type User = {
  email: string;
  name: string;
  role: "worker" | "supervisor" | "admin";
  companyRole: "owner" | "manager" | "viewer" | "crew" | null;
};

interface AuthContextType {
  isAuthenticated: boolean;
  user: User | null;
  lastEmail: string;
  loading: boolean;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (patch: Partial<User>) => Promise<void>;
  refreshToken: () => Promise<string | null>;
}

// Decode token expiry without full verification (verification happens server-side)
function getTokenExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[0];
    if (!payload) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return decoded.exp ?? null;
  } catch {
    return null;
  }
}

export function isTokenExpiringSoon(token: string | null, thresholdSeconds = 60 * 60): boolean {
  if (!token) return false;
  const exp = getTokenExpiry(token);
  if (!exp) return false;
  return exp - Math.floor(Date.now() / 1000) < thresholdSeconds;
}

const AuthContext = createContext<AuthContextType | null>(null);
const BASE_URL = resolveApiBaseUrl();

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function inferNameFromEmail(email: string): string {
  const localPart = email.split("@")[0] || "User";
  const words = localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ") || "User";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [lastEmail, setLastEmail] = useState("");
  const [loading, setLoading] = useState(true);

  // The single response to a refused credential, registered once.
  //
  // It lives here because this is the only component that can both discard the
  // session and outlive the screen the 401 came from. The alternative - each
  // screen handling its own 401 - is the arrangement that produced the defect:
  // fourteen places attach a bearer token, seven of them had their own fetch
  // helper, and a feature cannot say anything true about a dead session anyway.
  //
  // Clearing local state directly rather than calling logout(): logout() also
  // calls clearSessionExpired(), which would lower the notice this handler is
  // the response to, and the notice must stay raised until the person signs in.
  useEffect(() => {
    const previous = setSessionExpiredHandler(() => {
      void (async () => {
        try {
          await AsyncStorage.removeItem("sitesnap.token");
          await AsyncStorage.removeItem("sitesnap.user");
        } catch (err) {
          // Storage refusing to clear must not stop the navigation. Staying on
          // a screen whose every request 401s is worse than a stale key.
          console.warn("[auth] could not clear the stored session:", err);
        }
        setToken(null);
        setUser(null);
        setIsAuthenticated(false);
        // `replace`, not `push`: the screens behind this one belong to a
        // session that no longer exists, and a back gesture must not return to
        // them. The query parameter is how login.tsx knows to say why.
        router.replace("/login?expired=1");
      })();
    });
    return () => {
      setSessionExpiredHandler(previous);
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const token = await AsyncStorage.getItem("sitesnap.token");
        const userRaw = await AsyncStorage.getItem("sitesnap.user");
        const storedLastEmail = await AsyncStorage.getItem("sitesnap.lastEmail");
        if (storedLastEmail) {
          setLastEmail(storedLastEmail);
        }
        if (token && userRaw) {
          const parsed = JSON.parse(userRaw) as Partial<User>;
          const normalizedUser: User = {
            email: parsed.email || "",
            name: parsed.name || inferNameFromEmail(parsed.email || ""),
            role:
              parsed.role === "supervisor" || parsed.role === "admin" || parsed.role === "worker"
                ? parsed.role
                : "worker",
            companyRole:
              parsed.companyRole === "owner" || parsed.companyRole === "manager" ||
              parsed.companyRole === "viewer" || parsed.companyRole === "crew"
                ? parsed.companyRole
                : null,
          };
          setToken(token);
          setUser(normalizedUser);
          setIsAuthenticated(true);
        }
      } catch (err: unknown) {
        console.error("Auth restore failed:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      const url = `${BASE_URL}/api/auth/login`;
      console.log(`[auth] Login request URL: ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        let message = `Login failed (${res.status})`;
        try {
          const payload = (await res.json()) as { error?: string };
          if (payload.error) {
            message = payload.error;
          }
        } catch {
          const text = await res.text();
          if (text) {
            message = text;
          }
        }
        throw new Error(message);
      }

      const data = (await res.json()) as {
        token?: string;
        user?: { email?: string; name?: string; role?: "worker" | "supervisor" | "admin"; companyRole?: "owner" | "manager" | "viewer" | "crew" };
      };
      if (!data.token) {
        throw new Error("No token in response");
      }

      await AsyncStorage.setItem("sitesnap.token", data.token);
      const userObj: User = {
        email: data.user?.email || email,
        name: data.user?.name || inferNameFromEmail(email),
        role: data.user?.role || "worker",
        companyRole: data.user?.companyRole ?? null,
      };
      await AsyncStorage.setItem("sitesnap.user", JSON.stringify(userObj));
      await AsyncStorage.setItem("sitesnap.lastEmail", email);
      setToken(data.token);
      setLastEmail(email);
      setUser(userObj);
      setIsAuthenticated(true);
      // A session now exists, so the "your session has expired" notice is
      // stale. Lowering it here is what makes the NEXT expiry reportable; a
      // latch that is never lowered would announce the first expiry and then
      // go quiet for the life of the install.
      clearSessionExpired();
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      // Network loss is expected in dev if API is offline; avoid red-box console errors.
      console.warn("Login failed:", err);
      if (message.includes("Network request failed")) {
        Alert.alert(
          "Network Error",
          `Unable to reach ${BASE_URL}. Please verify the backend is running and reachable from your device.`
        );
      }
      throw err;
    }
  };

  const refreshToken = async (): Promise<string | null> => {
    if (!token) return null;
    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      // A 401 from the refresh endpoint is the most direct evidence there is
      // that the session is over - and it is also why refreshing cannot save
      // an expired token: /api/auth/refresh sits behind requireAuth, so the
      // same check that refused the original request refuses this one.
      if (res.status === 401) notifySessionExpired();
      if (!res.ok) return null;
      const data = (await res.json()) as { token?: string; user?: { email?: string; name?: string; role?: "worker" | "supervisor" | "admin"; companyRole?: "owner" | "manager" | "viewer" | "crew" } };
      if (!data.token) return null;
      await AsyncStorage.setItem("sitesnap.token", data.token);
      setToken(data.token);
      clearSessionExpired();
      if (data.user) {
        const nextUser: User = {
          email: data.user.email || user?.email || "",
          name: data.user.name || user?.name || "",
          role: data.user.role || user?.role || "worker",
          companyRole: data.user.companyRole ?? user?.companyRole ?? null,
        };
        setUser(nextUser);
        await AsyncStorage.setItem("sitesnap.user", JSON.stringify(nextUser));
      }
      return data.token;
    } catch {
      return null;
    }
  };

  const logout = async () => {
    try {
      await AsyncStorage.removeItem("sitesnap.token");
      await AsyncStorage.removeItem("sitesnap.user");
      setToken(null);
      setUser(null);
      setIsAuthenticated(false);
      clearSessionExpired();
    } catch (err: unknown) {
      console.warn("Logout failed:", err);
    }
  };

  const updateProfile = async (patch: Partial<User>) => {
    if (!user || !token) return;
    try {
      const url = `${BASE_URL}/api/auth/profile`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: patch.name, role: patch.role }),
      });

      if (res.status === 401) {
        notifySessionExpired();
        throw new SessionExpiredError();
      }
      if (!res.ok) {
        let message = `Profile update failed (${res.status})`;
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = (await res.json()) as { error?: string; message?: string };
          message = payload.error || payload.message || message;
        } else {
          const text = await res.text();
          if (text.trim().toLowerCase().startsWith("<!doctype html")) {
            message = "API returned HTML instead of JSON. Check EXPO_PUBLIC_API_URL and backend port.";
          } else if (text) {
            message = text;
          }
        }
        throw new Error(message);
      }

      const payload = (await res.json()) as {
        token?: string;
        user?: { email?: string; name?: string; role?: "worker" | "supervisor" | "admin"; companyRole?: "owner" | "manager" | "viewer" | "crew" };
      };
      const nextUser: User = {
        email: payload.user?.email || user.email,
        name: payload.user?.name || user.name,
        role: payload.user?.role || user.role,
        companyRole: payload.user?.companyRole ?? user.companyRole ?? null,
      };
      if (payload.token) {
        await AsyncStorage.setItem("sitesnap.token", payload.token);
        setToken(payload.token);
      }
      setUser(nextUser);
      await AsyncStorage.setItem("sitesnap.user", JSON.stringify(nextUser));
    } catch (err: unknown) {
      console.warn("Profile update failed:", err);
      throw err;
    }
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, lastEmail, loading, token, login, logout, updateProfile, refreshToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
