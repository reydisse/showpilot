import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
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
      <Page maxWidth={640}>
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
            <Text style={styles.title}>Your show, in your hands.</Text>
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
      </Page>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.stage },
  hero: { gap: spacing.xlarge, marginTop: spacing.medium },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  brandTile: { width: 54, height: 54, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  brand: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "900", letterSpacing: 2.1 },
  brandCaption: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "700", letterSpacing: 1.25, marginTop: 3 },
  copy: { gap: 9 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800", letterSpacing: 1.8 },
  title: { color: colors.text, fontFamily, fontSize: 37, lineHeight: 42, fontWeight: "800", letterSpacing: -1.2 },
  subtitle: { color: colors.textMuted, fontFamily, fontSize: 16, lineHeight: 24, maxWidth: 480 },
  formCard: { gap: spacing.medium, padding: spacing.large, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 18 },
  link: { color: colors.amberText, fontFamily, fontSize: 14, fontWeight: "700", textAlign: "center" },
  footer: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center", marginBottom: spacing.medium },
}));
