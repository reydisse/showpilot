import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Link, router } from "expo-router";
import * as Haptics from "expo-haptics";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { BrandMark } from "@/components/brand-mark";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { createThemedStyles, fontFamily, radii, spacing } from "@/theme/tokens";

export default function SignUpScreen() {
  const styles = useStyles();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function signUp() {
    if (!name.trim() || !email.trim() || password.length < 8) {
      setError("Enter your name, a valid email, and a password of at least 8 characters.");
      return;
    }
    setError("");
    setLoading(true);
    const result = await authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
    setLoading(false);
    if (result.error) {
      setError(result.error.message || "We could not create your account.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace("/organizations");
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Page maxWidth={640}>
        <View style={styles.brand}><BrandMark size={48} /></View>
        <View style={styles.copy}>
          <Text style={styles.eyebrow}>GET STARTED</Text>
          <Text style={styles.title}>Create your ShowPilot account.</Text>
          <Text style={styles.subtitle}>One account works on web, desktop, iPhone, and Android.</Text>
        </View>
        <View style={styles.formCard}>
          <AppField label="Name" value={name} onChangeText={setName} autoCapitalize="words" autoComplete="name" placeholder="Your name" />
          <AppField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" placeholder="you@example.com" />
          <AppField label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" placeholder="At least 8 characters" onSubmitEditing={signUp} />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <AppButton label="Create account" loading={loading} onPress={signUp} />
        </View>
        <Text style={styles.footer}>Already have an account? <Link href="/sign-in" style={styles.link}>Sign in</Link></Text>
      </Page>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.stage },
  brand: { marginTop: spacing.medium },
  copy: { gap: 9 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800", letterSpacing: 1.8 },
  title: { color: colors.text, fontFamily, fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -1 },
  subtitle: { color: colors.textMuted, fontFamily, fontSize: 16, lineHeight: 24 },
  formCard: { gap: spacing.medium, padding: spacing.large, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 18 },
  footer: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center" },
  link: { color: colors.amberText, fontWeight: "700" },
}));
