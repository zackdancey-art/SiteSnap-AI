import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useData, CompanyInviteResult } from "@/lib/data-context";
import { useAuth } from "@/lib/auth-context";
import Colors from "@/constants/colors";
import { ScreenHeader } from "@/components/ScreenHeader";

type Role = "manager" | "viewer" | "crew";

export default function CompanyInviteScreen() {
  const { user } = useAuth();
  const { inviteCompanyMembers } = useData();

  const [emailsText, setEmailsText] = useState("");
  const [role, setRole] = useState<Role>("crew");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<CompanyInviteResult[] | null>(null);

  const parseEmails = (raw: string): string[] =>
    raw
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes("@"));

  const handleSend = async () => {
    const emails = parseEmails(emailsText);
    if (emails.length === 0) {
      Alert.alert("No emails", "Enter at least one valid email address.");
      return;
    }
    setLoading(true);
    try {
      const res = await inviteCompanyMembers(emails, role);
      setResults(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert("Invite failed", msg);
    } finally {
      setLoading(false);
    }
  };

  /**
   * One description per outcome, derived from the WHOLE result rather than from
   * `status` alone.
   *
   * Both helpers used to take `status` and treat everything but `"sent"` as a
   * failure, which made a successful re-send read as "Failed to send" and
   * ignored `delivered` entirely. Keeping icon, colour and words in one
   * function is deliberate: split across two, they drifted.
   */
  const describe = (r: CompanyInviteResult): { glyph: keyof typeof Ionicons.glyphMap; color: string; label: string } => {
    if (r.status === "error") {
      return { glyph: "alert-circle-outline", color: Colors.error, label: "Could not create the invitation" };
    }
    if (r.status === "already_member") {
      return {
        glyph: "person-circle-outline",
        color: Colors.info,
        label: "Already in your team — no invitation needed",
      };
    }
    if (r.delivered === false) {
      // The re-send case keeps its warning about the old link: the old link is
      // dead either way, and the email failing does not bring it back.
      return {
        glyph: "warning-outline",
        color: Colors.warning,
        label:
          r.status === "resent"
            ? "Invitation re-issued, but the email could not be sent — any earlier link for this address has stopped working"
            : "Invitation created, but the email could not be sent",
      };
    }
    if (r.status === "resent") {
      return {
        glyph: "mail-outline",
        color: Colors.success,
        label: "Invitation re-sent — any earlier link for this address has stopped working",
      };
    }
    return { glyph: "mail-outline", color: Colors.success, label: "Invitation sent" };
  };

  /**
   * The heading claimed "Invites sent" for every outcome, including the ones
   * where nothing was sent. Say what happened instead.
   */
  const resultsHeading = (rs: CompanyInviteResult[]): string => {
    const emailed = rs.filter((r) => (r.status === "sent" || r.status === "resent") && r.delivered !== false).length;
    if (emailed === rs.length) return rs.length === 1 ? "Invitation sent" : "Invitations sent";
    if (emailed === 0) return "Nothing was emailed";
    return `${emailed} of ${rs.length} emailed`;
  };

  // Screen self-guards regardless of whether the settings entry point is hidden.
  if (user?.companyRole !== "owner") {
    return (
      <View style={styles.container}>
        <ScreenHeader
          variant="navy"
          title="Invite Team Member"
          backGlyph="arrow-back"
          backSize={22}
          paddingBottom={16}
          backButtonStyle={styles.backButton}
          titleStyle={styles.headerTitle}
          subtitleStyle={styles.headerSub}
        />
        <View style={styles.deniedWrap}>
          <Ionicons name="lock-closed-outline" size={32} color={Colors.textTertiary} />
          <Text style={styles.deniedText}>Only owners can invite company members.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScreenHeader
        variant="navy"
        title="Invite Team Member"
        backGlyph="arrow-back"
        backSize={22}
        paddingBottom={16}
        backButtonStyle={styles.backButton}
        titleStyle={styles.headerTitle}
        subtitleStyle={styles.headerSub}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {results === null ? (
          <>
            <Text style={styles.label}>Email addresses</Text>
            <TextInput
              style={styles.textArea}
              placeholder={"alice@example.com\nbob@example.com"}
              placeholderTextColor={Colors.textTertiary}
              multiline
              numberOfLines={6}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              value={emailsText}
              onChangeText={setEmailsText}
            />
            <Text style={styles.hint}>One email per line, or separated by commas.</Text>

            <Text style={[styles.label, { marginTop: 24 }]}>Role</Text>
            <View style={styles.roleRow}>
              {(["manager", "viewer", "crew"] as Role[]).map((r) => (
                <Pressable
                  key={r}
                  style={[styles.roleChip, role === r && styles.roleChipActive]}
                  onPress={() => setRole(r)}
                >
                  <Text style={[styles.roleChipText, role === r && styles.roleChipTextActive]}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              style={({ pressed }) => [styles.sendButton, pressed && { opacity: 0.85 }, loading && styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color={Colors.white} size="small" />
              ) : (
                <>
                  <Ionicons name="send-outline" size={18} color={Colors.white} />
                  <Text style={styles.sendButtonText}>Send Invites</Text>
                </>
              )}
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.resultsTitle}>{resultsHeading(results)}</Text>
            {results.map((r) => {
              const d = describe(r);
              return (
                <View key={r.email} style={styles.resultRow}>
                  <Ionicons name={d.glyph} size={16} color={d.color} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.resultEmail}>{r.email}</Text>
                    <Text style={styles.resultStatus}>{d.label}</Text>
                  </View>
                </View>
              );
            })}
            <Pressable
              style={({ pressed }) => [styles.sendButton, { marginTop: 24 }, pressed && { opacity: 0.85 }]}
              onPress={() => router.back()}
            >
              <Text style={styles.sendButtonText}>Done</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    fontWeight: undefined,
    color: Colors.white,
  },
  headerSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.6)",
    marginTop: 2,
  },
  deniedWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  deniedText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
    textAlign: "center",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 48,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  textArea: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.text,
    minHeight: 120,
    textAlignVertical: "top",
  },
  hint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textTertiary,
    marginTop: 6,
  },
  roleRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 8,
  },
  roleChip: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 12,
    backgroundColor: Colors.surfaceSecondary,
    borderWidth: 1.5,
    borderColor: Colors.border,
  },
  roleChipActive: {
    backgroundColor: Colors.accent + "14",
    borderColor: Colors.accent,
  },
  roleChipText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: Colors.textSecondary,
  },
  roleChipTextActive: {
    color: Colors.accent,
    fontFamily: "Inter_600SemiBold",
  },
  sendButton: {
    marginTop: 32,
    backgroundColor: Colors.accent,
    borderRadius: 14,
    height: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
  sendButtonText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.white,
  },
  resultsTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: Colors.text,
    marginBottom: 16,
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    shadowColor: Colors.cardShadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 4,
    elevation: 1,
  },
  resultEmail: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: Colors.text,
  },
  resultStatus: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: Colors.textTertiary,
  },
});
