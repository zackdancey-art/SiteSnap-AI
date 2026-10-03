import React from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { PRIVACY_POLICY } from "@/constants/legal/privacy-policy-content";
import Colors from "@/constants/colors";

/**
 * Privacy Policy screen.
 *
 * The text is NOT in this file. It lives in constants/legal/privacy-policy-content.ts,
 * which is one of two render targets for docs/legal/privacy-policy.md — the other is
 * website/privacy/index.html. Projects/scripts/ci.sh fails the build if the three
 * diverge, so a wording change has to be made in the canonical file and both copies
 * in the same commit. This file owns the layout and nothing else.
 *
 * The draft banner and the "assumptions to verify" box that used to be here are gone:
 * the entity is real (SiteSnap AI Limited, NZBN 9429053872258) and the assumptions they
 * listed have either been answered or been replaced by statements in the policy itself.
 * docs/legal/README.md records that the document has not been reviewed by a lawyer,
 * which is a fact about our process rather than a warning to show a user on every read.
 */

// Rendered as tappable inside body copy. Kept to the handful of destinations the policy
// actually names, so a stray word that happens to look like a domain is never linkified.
const LINKS: Array<{ match: string; url: string }> = [
  { match: "support@getsitesnapai.com", url: "mailto:support@getsitesnapai.com" },
  { match: "privacy.org.nz", url: "https://www.privacy.org.nz" },
  { match: "oaic.gov.au", url: "https://www.oaic.gov.au" },
];

const LINK_PATTERN = new RegExp(
  `(${LINKS.map((l) => l.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
  "g"
);

function Body({ children }: { children: string }) {
  const parts = children.split(LINK_PATTERN);
  return (
    <Text style={styles.cardBody}>
      {parts.map((part, i) => {
        const link = LINKS.find((l) => l.match === part);
        if (!link) return part;
        return (
          <Text key={i} style={styles.link} onPress={() => Linking.openURL(link.url)}>
            {part}
          </Text>
        );
      })}
    </Text>
  );
}

export default function PrivacyPolicyScreen() {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>{PRIVACY_POLICY.title}</Text>
        <Text style={styles.heroSub}>{PRIVACY_POLICY.lastUpdated}</Text>
        {PRIVACY_POLICY.intro.map((paragraph, i) => (
          <Text key={i} style={styles.heroText}>
            {paragraph}
          </Text>
        ))}
      </View>

      {PRIVACY_POLICY.sections.map((section) => (
        <View key={section.title} style={styles.card}>
          <Text style={styles.cardTitle}>{section.title}</Text>
          {section.paragraphs.map((paragraph, i) => (
            <Body key={i}>{paragraph}</Body>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  hero: {
    backgroundColor: Colors.primary,
    borderRadius: 22,
    padding: 22,
    gap: 8,
  },
  heroTitle: { fontSize: 24, fontFamily: "Inter_700Bold", color: Colors.white },
  heroSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.55)" },
  heroText: { fontSize: 14, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.84)", lineHeight: 21 },
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 18,
    padding: 16,
    gap: 8,
  },
  cardTitle: { fontSize: 15, fontFamily: "Inter_700Bold", color: Colors.text },
  cardBody: { fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.textSecondary, lineHeight: 21 },
  link: { fontFamily: "Inter_500Medium", color: Colors.accent },
});
