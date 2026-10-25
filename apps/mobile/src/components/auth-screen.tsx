import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import {
  getSignInDesign,
  PASSWORD_MIN_LENGTH,
  signInArtworkCopy,
} from "@showpilot/shared";
import ArrowRight from "lucide-react-native/icons/arrow-right";
import Eye from "lucide-react-native/icons/eye";
import EyeOff from "lucide-react-native/icons/eye-off";
import Pause from "lucide-react-native/icons/pause";
import Play from "lucide-react-native/icons/play";
import { AuthArtwork } from "@/components/auth-artwork";
import { BrandMark } from "@/components/brand-mark";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";
import * as Haptics from "@/lib/haptics";

type AuthMode = "sign-in" | "sign-up";

export function AuthScreen({ mode }: { mode: AuthMode }) {
  const signingUp = mode === "sign-up";
  const { width, fontScale } = useWindowDimensions();
  const wide = width > 900 && fontScale <= 1.3;
  const inset = wide
    ? Math.min(64, Math.max(28, width * 0.04))
    : Math.min(48, Math.max(20, width * 0.05));
  const [design] = useState(() => getSignInDesign(new Date()));
  const copy = signInArtworkCopy[design];
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const submitting = useRef(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const [paused, setPaused] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);
  const drift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (paused || reduceMotion) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, {
          toValue: 1,
          duration: 10_000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(drift, {
          toValue: 0,
          duration: 10_000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [drift, paused, reduceMotion]);

  async function submit() {
    if (submitting.current) return;
    if (
      !email.trim() ||
      !password ||
      (signingUp && (!name.trim() || password.length < PASSWORD_MIN_LENGTH))
    ) {
      setError(
        signingUp
          ? `Enter your name, a valid email, and a password of at least ${PASSWORD_MIN_LENGTH} characters.`
          : "Enter your email and password.",
      );
      return;
    }
    setError("");
    submitting.current = true;
    setLoading(true);
    try {
      const result = signingUp
        ? await authClient.signUp.email({
            name: name.trim(),
            email: email.trim(),
            password,
          })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error)
        throw new Error(
          result.error.message ||
            (signingUp
              ? "We could not create your account."
              : "Invalid email or password."),
        );
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/organizations");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "ShowPilot could not be reached. Check your connection and try again.",
      );
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  }

  const motionControl = !reduceMotion ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        paused ? "Resume artwork animation" : "Pause artwork animation"
      }
      accessibilityState={{ selected: paused }}
      onPress={() => setPaused(!paused)}
      style={styles.iconButton}
    >
      {paused ? (
        <Play size={16} color="#a5a69d" />
      ) : (
        <Pause size={16} color="#a5a69d" />
      )}
    </Pressable>
  ) : null;

  const artwork = (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.artwork,
        {
          transform: [
            {
              translateY: drift.interpolate({
                inputRange: [0, 1],
                outputRange: [0, -6],
              }),
            },
            {
              rotate: drift.interpolate({
                inputRange: [0, 1],
                outputRange: ["0deg", "2deg"],
              }),
            },
          ],
        },
      ]}
    >
      <AuthArtwork design={design} />
    </Animated.View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.canvas, wide && styles.canvasWide]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={
            Platform.OS === "ios" ? "interactive" : "on-drag"
          }
        >
          <View
            testID="auth-entry"
            style={[
              styles.entry,
              wide && styles.entryWide,
              { paddingHorizontal: inset },
            ]}
          >
            <View style={styles.brandRow}>
              <View
                accessibilityLabel="ShowPilot"
                accessibilityRole="header"
                style={styles.wordmark}
              >
                <BrandMark size={29} />
                <View style={styles.brandName}>
                  <Text
                    maxFontSizeMultiplier={1.5}
                    style={[styles.brandText, styles.brandGold]}
                  >
                    Show
                  </Text>
                  <Text maxFontSizeMultiplier={1.5} style={styles.brandText}>
                    Pilot
                  </Text>
                </View>
              </View>
              {!wide && fontScale <= 1.3 ? (
                <View style={styles.motif}>{artwork}</View>
              ) : null}
            </View>
            <View style={styles.formSpace}>
              <View style={[styles.form, { maxWidth: wide ? 480 : 448 }]}>
                <Text style={styles.eyebrow}>YOUR NEXT SHOW STARTS HERE</Text>
                <Text
                  accessibilityRole="header"
                  style={[
                    styles.title,
                    wide && {
                      fontSize: Math.min(56, Math.max(36, width * 0.035)),
                      lineHeight: Math.min(64, Math.max(42, width * 0.04)),
                    },
                  ]}
                >
                  {signingUp
                    ? "Your next great\nshow starts here."
                    : "Good to have\nyou back."}
                </Text>
                <Text style={styles.intro}>
                  {signingUp
                    ? "Create an account to bring your team together."
                    : "Your team. Your cues. All in one place."}
                </Text>
                <View style={styles.fields}>
                  {signingUp ? (
                    <AuthField
                      label="Full name"
                      value={name}
                      onChangeText={setName}
                      placeholder="Your name"
                      autoComplete="name"
                      textContentType="name"
                      autoCapitalize="words"
                      returnKeyType="next"
                      submitBehavior="submit"
                      onSubmitEditing={() => emailRef.current?.focus()}
                      editable={!loading}
                    />
                  ) : null}
                  <AuthField
                    inputRef={emailRef}
                    label="Email address"
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    keyboardType="email-address"
                    autoComplete="email"
                    textContentType="emailAddress"
                    autoCorrect={false}
                    returnKeyType="next"
                    submitBehavior="submit"
                    onSubmitEditing={() => passwordRef.current?.focus()}
                    editable={!loading}
                  />
                  <View>
                    <View style={styles.passwordLabel}>
                      <Text style={styles.label}>Password</Text>
                      {!signingUp ? (
                        <Pressable
                          accessibilityRole="link"
                          accessibilityLabel="Forgot password?"
                          onPress={() =>
                            void Linking.openURL(
                              `${SHOWPILOT_URL}/forgot-password`,
                            )
                          }
                          style={styles.forgotLink}
                        >
                          <Text style={styles.secondaryLink}>
                            Forgot password?
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    <View style={styles.passwordField}>
                      <AuthField
                        inputRef={passwordRef}
                        label="Password"
                        hideLabel
                        value={password}
                        onChangeText={setPassword}
                        placeholder={
                          signingUp
                            ? `At least ${PASSWORD_MIN_LENGTH} characters`
                            : "Enter your password"
                        }
                        secureTextEntry={!showPassword}
                        autoComplete={
                          signingUp ? "new-password" : "current-password"
                        }
                        textContentType={signingUp ? "newPassword" : "password"}
                        returnKeyType="go"
                        onSubmitEditing={() => void submit()}
                        editable={!loading}
                        style={styles.passwordInput}
                      />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={
                          showPassword ? "Hide password" : "Show password"
                        }
                        onPress={() => setShowPassword(!showPassword)}
                        style={[styles.iconButton, styles.eye]}
                      >
                        {showPassword ? (
                          <EyeOff size={19} color="#999aa2" />
                        ) : (
                          <Eye size={19} color="#999aa2" />
                        )}
                      </Pressable>
                    </View>
                  </View>
                </View>
                {error ? (
                  <Text
                    accessibilityRole="alert"
                    accessibilityLiveRegion="polite"
                    style={styles.error}
                  >
                    {error}
                  </Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={signingUp ? "Create account" : "Sign in"}
                  accessibilityState={{ disabled: loading, busy: loading }}
                  disabled={loading}
                  onPress={() => void submit()}
                  style={({ pressed }) => [
                    styles.submit,
                    pressed && styles.submitPressed,
                    loading && styles.disabled,
                  ]}
                >
                  <Text style={styles.submitText}>
                    {loading
                      ? signingUp
                        ? "Creating account…"
                        : "Signing in…"
                      : signingUp
                        ? "Create account"
                        : "Sign in"}
                  </Text>
                  {loading ? (
                    <ActivityIndicator size="small" color="#171307" />
                  ) : (
                    <ArrowRight size={18} color="#171307" />
                  )}
                </Pressable>
                {signingUp ? (
                  <Text style={styles.legal}>
                    By creating an account you agree to the{" "}
                    <Text
                      accessibilityRole="link"
                      onPress={() =>
                        void Linking.openURL(`${SHOWPILOT_URL}/terms`)
                      }
                      style={styles.legalLink}
                    >
                      Terms of Service
                    </Text>{" "}
                    and{" "}
                    <Text
                      accessibilityRole="link"
                      onPress={() =>
                        void Linking.openURL(`${SHOWPILOT_URL}/privacy`)
                      }
                      style={styles.legalLink}
                    >
                      Privacy Policy
                    </Text>
                    .
                  </Text>
                ) : null}
                <View style={styles.switchRow}>
                  <Text style={styles.switchPrompt}>
                    {signingUp
                      ? "Already have an account?"
                      : "New to ShowPilot?"}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      signingUp ? "Sign in instead" : "Create an account"
                    }
                    disabled={loading}
                    onPress={() =>
                      router.replace(signingUp ? "/sign-in" : "/sign-up")
                    }
                    style={styles.textButton}
                  >
                    <Text style={styles.switchLink}>
                      {signingUp ? "Sign in instead" : "Create an account"} ↗
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
            <View style={styles.footer}>
              <Text style={styles.footerText}>
                Made for the people behind the show.
              </Text>
              <View style={styles.footerLinks}>
                {!wide ? motionControl : null}
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="Privacy"
                  onPress={() =>
                    void Linking.openURL(`${SHOWPILOT_URL}/privacy`)
                  }
                  style={styles.textButton}
                >
                  <Text style={styles.footerText}>Privacy</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="Terms"
                  onPress={() => void Linking.openURL(`${SHOWPILOT_URL}/terms`)}
                  style={styles.textButton}
                >
                  <Text style={styles.footerText}>Terms</Text>
                </Pressable>
              </View>
            </View>
          </View>
          {wide ? (
            <View
              testID="auth-art-panel"
              style={[
                styles.artPanel,
                { paddingHorizontal: inset },
                design === "afterglow" && styles.afterglow,
                design === "in-sync" && styles.inSync,
              ]}
            >
              <Text style={styles.artTop}>✳ BEHIND EVERY GREAT MOMENT</Text>
              <View style={styles.artSpace}>{artwork}</View>
              <View style={styles.artCopy}>
                <Text style={styles.overline}>{copy.overline}</Text>
                <Text
                  style={[
                    styles.artTitle,
                    {
                      fontSize: Math.min(48, Math.max(32, width * 0.032)),
                      lineHeight: Math.min(56, Math.max(38, width * 0.038)),
                    },
                  ]}
                >
                  {copy.title}
                </Text>
                <Text style={styles.artDescription}>{copy.description}</Text>
                <View style={styles.artFooter}>
                  <Text style={styles.artCaption}>
                    LIVE PRODUCTION, CONNECTED.
                  </Text>
                  {motionControl}
                </View>
              </View>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function AuthField({
  label,
  hideLabel = false,
  inputRef,
  style,
  ...props
}: TextInputProps & {
  label: string;
  hideLabel?: boolean;
  inputRef?: React.Ref<TextInput>;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      {!hideLabel ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        autoCapitalize="none"
        placeholderTextColor="#81828b"
        selectionColor="#ffc107"
        keyboardAppearance="dark"
        style={[styles.input, focused && styles.inputFocused, style]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...props}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#101113" },
  flex: { flex: 1 },
  canvas: { flexGrow: 1 },
  canvasWide: { flexDirection: "row" },
  entry: { flexGrow: 1, paddingTop: 28, paddingBottom: 20, minWidth: 0 },
  entryWide: { flex: 1 },
  brandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 48,
  },
  wordmark: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    flexShrink: 1,
  },
  brandName: { flexDirection: "row", alignItems: "center" },
  brandText: {
    fontSize: 24,
    fontWeight: "600",
    letterSpacing: -0.8,
    color: "#eeeeee",
  },
  brandGold: { color: "#ffc107" },
  motif: { width: 86, height: 64, opacity: 0.55, marginVertical: -8 },
  formSpace: { flexGrow: 1, justifyContent: "center", paddingVertical: 40 },
  form: { width: "100%", alignSelf: "center" },
  eyebrow: {
    color: "#999a9e",
    fontSize: 11,
    letterSpacing: 1.9,
    marginBottom: 20,
  },
  title: {
    color: "#eeeeee",
    fontSize: 36,
    lineHeight: 42,
    fontWeight: "500",
    letterSpacing: -1.5,
    marginBottom: 15,
  },
  intro: { color: "#999aa2", fontSize: 16, lineHeight: 26, marginBottom: 34 },
  fields: { gap: 23 },
  field: { gap: 9 },
  label: { fontSize: 14, color: "#c4c4c9" },
  input: {
    width: "100%",
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#333438",
    backgroundColor: "#17181b",
    color: "#eeeeee",
    fontSize: 16,
  },
  inputFocused: { borderColor: "#b18f35" },
  passwordLabel: {
    minHeight: 28,
    marginBottom: 9,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: 12,
    rowGap: 6,
  },
  forgotLink: { minHeight: 44, justifyContent: "center", marginVertical: -8 },
  secondaryLink: { fontSize: 13, color: "#b0b1b8" },
  passwordField: { position: "relative" },
  passwordInput: { paddingRight: 52 },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  eye: { position: "absolute", right: 4, top: "50%", marginTop: -22 },
  error: {
    color: "#fca5a5",
    backgroundColor: "#f871710d",
    borderColor: "#f8717140",
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 16,
    fontSize: 13,
    lineHeight: 20,
  },
  submit: {
    minHeight: 52,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginTop: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ffce3d",
    backgroundColor: "#ffc107",
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  submitPressed: { backgroundColor: "#ffd044" },
  disabled: { opacity: 0.6 },
  submitText: {
    fontSize: 15,
    color: "#171307",
    fontWeight: "600",
    flexShrink: 1,
  },
  legal: { marginTop: 18, fontSize: 13, lineHeight: 23, color: "#999aa2" },
  legalLink: { textDecorationLine: "underline" },
  switchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    columnGap: 5,
    marginTop: 17,
  },
  switchPrompt: { fontSize: 14, color: "#a1a2aa" },
  switchLink: { fontSize: 14, color: "#dddddd" },
  textButton: { minHeight: 44, justifyContent: "center" },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    columnGap: 16,
    rowGap: 8,
  },
  footerText: { fontSize: 12, lineHeight: 18, color: "#999aa2", flexShrink: 1 },
  footerLinks: { flexDirection: "row", alignItems: "center", gap: 16 },
  artPanel: {
    flex: 1,
    minWidth: 0,
    paddingTop: 40,
    paddingBottom: 24,
    backgroundColor: "#191917",
    borderLeftWidth: 1,
    borderColor: "#ffffff08",
    overflow: "hidden",
  },
  afterglow: { backgroundColor: "#151614", margin: 16, borderRadius: 16 },
  inSync: { backgroundColor: "#15191a" },
  artTop: { color: "#b4b3a7", fontSize: 11, letterSpacing: 1.4 },
  artSpace: {
    flexGrow: 1,
    minHeight: 300,
    justifyContent: "center",
    marginHorizontal: -20,
    paddingVertical: 24,
  },
  artwork: { width: "100%", aspectRatio: 1.25 },
  artCopy: { paddingTop: 8 },
  overline: { fontSize: 11, letterSpacing: 1.8, color: "#b19d65" },
  artTitle: {
    color: "#e1ded2",
    fontWeight: "400",
    letterSpacing: -1.2,
    marginTop: 18,
    marginBottom: 15,
  },
  artDescription: {
    color: "#a7a89e",
    fontSize: 15,
    lineHeight: 27,
    marginBottom: 34,
  },
  artFooter: {
    borderTopWidth: 1,
    borderColor: "#ffffff12",
    paddingTop: 8,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  artCaption: {
    fontSize: 11,
    letterSpacing: 1.3,
    color: "#999b90",
    flexShrink: 1,
  },
});
