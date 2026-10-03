import React from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { TERMS_OF_SERVICE } from "@/constants/legal/terms-of-service-content";
import Colors from "@/constants/colors";

/**
 * Terms of Service screen.
 *
 * The text is NOT in this file. It lives in constants/legal/terms-of-service-content.ts,
 * which is one of two render targets for docs/legal/terms-of-service.md — the other is
 * website/terms/index.html. Projects/scripts/ci.sh fails the build if the three diverge.
 * This file owns the layout and nothing else. See the note in privacy-policy.tsx for why
 * the draft banner and assumptions box are gone.
 */

const LINKS: Array<{ match: string; url: string }> = [
  { match: "support@getsitesnapai.com", url: "mailto:support@getsitesnapai.com" },
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

export default function TermsOfServiceScreen() {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>{TERMS_OF_SERVICE.title}</Text>
        <Text style={styles.heroSub}>{TERMS_OF_SERVICE.lastUpdated}</Text>
        {TERMS_OF_SERVICE.intro.map((paragraph, i) => (
          <Text key={i} style={styles.heroText}>
            {paragraph}
          </Text>
        ))}
      </View>

      {TERMS_OF_SERVICE.sections.map((section) => (
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
