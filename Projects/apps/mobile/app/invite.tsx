import React, { useEffect, useState } from "react";
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useData } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import { describeInviteRefusal } from "@/lib/invite-refusal";
import Colors from "@/constants/colors";

type State =
  | { phase: "loading" }
  // siteId and siteName are null for a COMPANY invitation — the API returns
  // siteId: null for one, and the types claiming `string` here is why the
  // success screen rendered "joined null" and navigated to /site/null.
  | { phase: "success"; siteName: string | null; siteId: string | null; role: string }
  // invitedEmail is non-null only for the wrong-recipient refusal, and it is
  // what gates the Sign out control below. See lib/invite-refusal.ts.
  | { phase: "error"; message: string; invitedEmail: string | null };

export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { isAuthenticated, logout } = useAuth();
  const { acceptInvite } = useData();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ phase: "error", message: "No invite token found in the link.", invitedEmail: null });
      return;
    }
    if (!isAuthenticated) {
      // SIGNUP, not login.
      //
      // This used to send the invitee to /login with the invite link in `next`.
      // Two things were wrong with that. login.tsx never read `next`, so the
      // token was discarded; and an invitee almost by definition has no account
      // yet, so the screen they were shown was the one they could not use. The
      // signup screen carries the token into registration, where the API
      // attaches the new account to the inviting company, and it offers
      // "Already have an account?" for the minority who do.
      router.replace({ pathname: "/signup", params: { inviteToken: token } });
      return;
    }
    acceptInvite(token)
      .then((result) => {
        setState({ phase: "success", siteName: result.siteName, siteId: result.siteId, role: result.role });
      })
      .catch((err: unknown) => {
        // The branching that used to live here read the server's prose for
        // tokens the server does not send ("not_found", "wrong_user", "403"),
        // so it chose its wording by accident - and the one refusal a person
        // can actually act on was the one it could not recognise. The decision
        // now happens in lib/invite-refusal.ts, on the status and code that
        // data-context's doFetch finally carries, where it is tested.
        const refusal = describeInviteRefusal(err);
        setState({ phase: "error", message: refusal.message, invitedEmail: refusal.invitedEmail });
      });
  }, [token, isAuthenticated]);

  return (
    <View style={[styles.container, { paddingTop: insets.top + 24 }]}>
      {state.phase === "loading" && (
        <View style={styles.centred}>
          <ActivityIndicator size="large" color={Colors.accent} />
          <Text style={styles.loadingText}>Accepting invite…</Text>
        </View>
      )}

      {state.phase === "success" && (
        <View style={styles.centred}>
          <View style={styles.iconCircle}>
            <Ionicons name="checkmark-circle" size={56} color={Colors.success} />
          </View>
          <Text style={styles.title}>You're in!</Text>
          <Text style={styles.subtitle}>
            {state.siteName ? (
              <>
                You&apos;ve joined <Text style={styles.bold}>{state.siteName}</Text> as a{" "}
                <Text style={styles.bold}>{state.role}</Text>.
              </>
            ) : (
              <>You&apos;ve joined the team. Your sites will appear on your dashboard.</>
            )}
          </Text>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
            onPress={() =>
              // A COMPANY invitation has no site — the API returns siteId null
              // for one — so this navigated to /site/null and landed the user on
              // a broken screen at the exact moment they had just joined.
              state.siteId
                ? router.replace({ pathname: "/site/[id]", params: { id: state.siteId } })
                : router.replace("/(tabs)")
            }
          >
            <Text style={styles.buttonText}>{state.siteId ? "Go to Site" : "Get Started"}</Text>
          </Pressable>
        </View>
      )}

      {state.phase === "error" && (
        <View style={styles.centred}>
          <View style={styles.iconCircle}>
            <Ionicons name="close-circle" size={56} color={Colors.error} />
          </View>
          <Text style={styles.title}>Couldn't accept invite</Text>
          <Text style={styles.subtitle}>{state.message}</Text>
          {/*
            Sign out is offered only for the refusal it actually resolves. The
            token is still in the route params, and the effect above keys on
            isAuthenticated - so signing out re-runs it, finds no session, and
            sends the invitation straight on to /signup with the token still
            attached. The person ends up where the invitation was always meant
            to take them, without having to find the link again.
          */}
          {state.invitedEmail ? (
            <Pressable
              style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
              onPress={() => {
                void logout();
              }}
            >
              <Text style={styles.buttonText}>Sign out and accept</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && { opacity: 0.85 }]}
            onPress={() => router.replace("/(tabs)/")}
          >
            <Text style={styles.buttonTextSecondary}>Go to Home</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingHorizontal: 24,
  },
  centred: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  iconCircle: {
    marginBottom: 8,
  },
  loadingText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  title: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: 8,
  },
  bold: {
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  button: {
    marginTop: 8,
    backgroundColor: Colors.accent,
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 14,
  },
  buttonText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  buttonSecondary: {
    backgroundColor: Colors.accent + "14",
  },
  buttonTextSecondary: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.accent,
  },
});
