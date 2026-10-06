import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Link, router } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { BrandMark } from "@/components/brand-mark";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";
import { createThemedStyles, fontFamily, radii, spacing } from "@/theme/tokens";

export default function SignInScreen() {
  const styles = useStyles();
  const { width, fontScale } = useWindowDimensions();
  const spacious = width >= 760 && fontScale <= 1.3;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function signIn() {
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) throw new Error(result.error.message || "Invalid email or password.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/organizations");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ShowPilot could not be reached. Check your connection and try again.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Page maxWidth={spacious ? 1160 : 640}>
        <View style={[styles.layout, spacious && styles.layoutSpacious]}>
          {spacious ? (
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.depth}>
              <DepthCard side="left" />
              <DepthCard side="right" />
            </View>
          ) : null}
          <View style={[styles.content, spacious && styles.contentSpacious]}>
            <View style={styles.hero}>
              <View style={styles.brandRow}>
                <View style={styles.brandTile}><BrandMark size={42} /></View>
                <View>
                  <Text style={styles.brand}>SHOWPILOT</Text>
                  <Text style={styles.brandCaption}>LIVE PRODUCTION CONTROL</Text>
                </View>
              </View>
              <View style={styles.copy}>
                <Text style={styles.eyebrow}>WELCOME BACK</Text>
                <Text style={[styles.title, spacious && styles.titleSpacious]}>Your show, in your hands.</Text>
                <Text style={styles.subtitle}>Sign in to run shows, coordinate your crew, and stay in sync from anywhere.</Text>
              </View>
            </View>

            <View style={styles.formCard}>
              <AppField
                label="Email"
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                keyboardType="email-address"
                autoComplete="email"
                returnKeyType="next"
              />
              <AppField
                label="Password"
                value={password}
                onChangeText={setPassword}
                placeholder="Your password"
                secureTextEntry
                autoComplete="current-password"
                returnKeyType="go"
                onSubmitEditing={signIn}
              />
              {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
              <AppButton label="Sign in" loading={loading} onPress={signIn} />
              <Pressable accessibilityRole="link" accessibilityLabel="Forgot password" onPress={() => Linking.openURL(`${SHOWPILOT_URL}/forgot-password`)} hitSlop={10}>
                <Text style={styles.link}>Forgot password?</Text>
              </Pressable>
            </View>

            <Text style={styles.footer}>
              New to ShowPilot? <Link href="/sign-up" style={styles.link}>Create an account</Link>
            </Text>
          </View>
        </View>
      </Page>
    </KeyboardAvoidingView>
  );
}

function DepthCard({ side }: { side: "left" | "right" }) {
  const styles = useStyles();
  return (
    <View style={[styles.depthStack, side === "left" ? styles.depthLeft : styles.depthRight]}>
      <View style={styles.depthLayer} />
      <View style={[styles.depthLayer, styles.depthMiddle]} />
      <View style={[styles.depthLayer, styles.depthFront]}>
        <View style={styles.depthHeading}><View style={styles.depthAccent} /><View style={styles.depthBadge} /></View>
        {[0, 1, 2].map((row) => (
          <View key={row} style={styles.depthRow}>
            <View style={[styles.depthDot, row === 0 && styles.depthDotActive]} />
            <View style={[styles.depthLine, row === 1 && styles.depthLineShort]} />
            <View style={styles.depthTime} />
          </View>
        ))}
        <View style={styles.depthTrack}><View style={[styles.depthProgress, side === "right" && styles.depthProgressLong]} /></View>
      </View>
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.stage },
  layout: { flexGrow: 1 },
  layoutSpacious: { justifyContent: "center", paddingVertical: 48 },
  content: { width: "100%", gap: 12 },
  contentSpacious: { maxWidth: 480, alignSelf: "center", gap: 24 },
  depth: { ...StyleSheet.absoluteFillObject, overflow: "hidden" },
  depthStack: { position: "absolute", width: 240, height: 170, opacity: 0.55 },
  depthLeft: { right: "76%", top: "52%", transform: [{ perspective: 900 }, { rotateX: "52deg" }, { rotateZ: "-24deg" }] },
  depthRight: { left: "78%", top: "28%", opacity: 0.35, transform: [{ perspective: 900 }, { rotateX: "52deg" }, { rotateZ: "24deg" }] },
  depthLayer: { ...StyleSheet.absoluteFillObject, borderRadius: 20, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stage },
  depthMiddle: { transform: [{ translateY: -28 }] },
  depthFront: { transform: [{ translateY: -56 }], borderTopColor: colors.amberBorder },
  depthHeading: { marginHorizontal: 22, marginTop: 22, marginBottom: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  depthAccent: { width: 28, height: 2, borderRadius: 2, backgroundColor: colors.amberBorder },
  depthBadge: { width: 18, height: 5, borderWidth: 1, borderColor: colors.textMuted, borderRadius: 4, opacity: 0.18 },
  depthRow: { marginHorizontal: 22, height: 27, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft },
  depthDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: colors.textMuted, opacity: 0.22 },
  depthDotActive: { backgroundColor: colors.amberBorder, opacity: 1 },
  depthLine: { width: "46%", height: 3, borderRadius: 2, backgroundColor: colors.textMuted, opacity: 0.16 },
  depthLineShort: { width: "34%" },
  depthTime: { width: 19, height: 3, marginLeft: "auto", borderRadius: 2, backgroundColor: colors.textMuted, opacity: 0.16 },
  depthTrack: { height: 2, marginHorizontal: 22, marginTop: 18, backgroundColor: colors.borderSoft },
  depthProgress: { width: "32%", height: 2, backgroundColor: colors.amberBorder, opacity: 0.6 },
  depthProgressLong: { width: "58%" },
  hero: { gap: spacing.xlarge, marginTop: spacing.medium },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  brandTile: { width: 54, height: 54, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  brand: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "900", letterSpacing: 2.1 },
  brandCaption: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "700", letterSpacing: 1.25, marginTop: 3 },
  copy: { gap: 9 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800", letterSpacing: 1.8 },
  title: { color: colors.text, fontFamily, fontSize: 37, lineHeight: 42, fontWeight: "800", letterSpacing: -1.2 },
  titleSpacious: { fontSize: 30, lineHeight: 36, fontWeight: "700", letterSpacing: -0.7 },
  subtitle: { color: colors.textMuted, fontFamily, fontSize: 16, lineHeight: 24, maxWidth: 480 },
  formCard: { gap: spacing.medium, padding: spacing.large, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 18 },
  link: { color: colors.amberText, fontFamily, fontSize: 14, fontWeight: "700", textAlign: "center" },
  footer: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center", marginBottom: spacing.medium },
}));
