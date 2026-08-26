import { useState } from "react";
import BadgeCheck from "lucide-react-native/icons/badge-check";
import Building2 from "lucide-react-native/icons/building-2";
import Camera from "lucide-react-native/icons/camera";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Mail from "lucide-react-native/icons/mail";
import Save from "lucide-react-native/icons/save";
import Settings2 from "lucide-react-native/icons/settings-2";
import UserRound from "lucide-react-native/icons/user-round";
import { Alert, Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "@/lib/haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { resolveMobileAvatarUrl, saveMobilePushToken, uploadMobileAvatar } from "@/lib/mobile-api";
import { getNativePushToken } from "@/lib/native-notifications";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function ProfileScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const name = nameDraft ?? session?.user.name ?? "";
  const resolvedAvatarUrl = resolveMobileAvatarUrl(session?.user.image);
  const avatarUrl = resolvedAvatarUrl && resolvedAvatarUrl !== failedAvatarUrl
    ? resolvedAvatarUrl
    : null;

  async function saveName() {
    const clean = name.trim();
    if (!clean || clean === session?.user.name) return;
    setSavingName(true);
    try {
      const result = await authClient.updateUser({ name: clean });
      if (result.error) throw new Error(result.error.message || "Name could not be saved.");
      await refetchSession();
      setNameDraft(null);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert("Profile not saved", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  async function chooseAvatar() {
    setSavingAvatar(true);
    try {
      const selection = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      });
      if (selection.canceled) return;
      const processed = await ImageManipulator.manipulateAsync(
        selection.assets[0].uri,
        [{ resize: { width: 640, height: 640 } }],
        { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG },
      );
      const uploaded = await uploadMobileAvatar(processed.uri);
      const result = await authClient.updateUser({ image: uploaded.url });
      if (result.error) throw new Error(result.error.message || "Photo could not be saved.");
      setFailedAvatarUrl(null);
      await refetchSession();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert("Photo not saved", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setSavingAvatar(false);
    }
  }

  async function signOut() {
    setSigningOut(true);
    try {
      const token = await getNativePushToken().catch(() => null);
      if (token && organization?.id && (Platform.OS === "ios" || Platform.OS === "android")) {
        await saveMobilePushToken(organization.id, token, Platform.OS, false).catch(() => undefined);
      }
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message || "Sign out could not be completed.");
      await Haptics.selectionAsync();
      router.replace("/sign-in");
    } catch (error) {
      Alert.alert("Could not sign out", error instanceof Error ? error.message : "Check your connection and try again.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <Page eyebrow="YOUR ACCOUNT" title="Profile" maxWidth={720}>
      <View style={styles.profileCard}>
        <View style={styles.identity}>
          <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo" accessibilityState={{ busy: savingAvatar }} disabled={savingAvatar} onPress={chooseAvatar} style={({ pressed }) => [styles.avatar, pressed && styles.pressed, savingAvatar && styles.disabled]}>
            {avatarUrl ? <Image source={{ uri: avatarUrl }} onError={() => setFailedAvatarUrl(avatarUrl)} style={styles.avatarImage} /> : <UserRound size={31} color={colors.black} />}
            <View style={styles.cameraBadge}><Camera size={12} color={colors.black} /></View>
          </Pressable>
          <View style={styles.identityCopy}>
            <Text style={styles.name}>{session?.user.name || "ShowPilot user"}</Text>
            <Text style={styles.email}>{session?.user.email}</Text>
            <View style={styles.verifiedBadge}><BadgeCheck size={13} color={session?.user.emailVerified ? colors.green : colors.amberText} /><Text style={[styles.verifiedText, session?.user.emailVerified && styles.verifiedTextReady]}>{session?.user.emailVerified ? "Verified account" : "Verification required"}</Text></View>
          </View>
        </View>
        {savingAvatar ? <Text style={styles.savingText}>Preparing and saving your photo…</Text> : null}
      </View>
      <View style={styles.editor}>
        <Text style={styles.editorLabel}>DISPLAY NAME</Text>
        <View style={styles.editorRow}>
          <TextInput accessibilityLabel="Display name" autoCapitalize="words" maxLength={80} value={name} onChangeText={setNameDraft} placeholder="Your name" placeholderTextColor={colors.textFaint} style={styles.nameInput} />
          <Pressable accessibilityRole="button" accessibilityLabel="Save display name" accessibilityState={{ busy: savingName, disabled: savingName || !name.trim() || name.trim() === session?.user.name }} disabled={savingName || !name.trim() || name.trim() === session?.user.name} onPress={saveName} style={({ pressed }) => [styles.saveButton, (savingName || !name.trim() || name.trim() === session?.user.name) && styles.disabled, pressed && styles.pressed]}><Save size={18} color={colors.black} /></Pressable>
        </View>
      </View>
      <View style={styles.section}>
        <View style={styles.row}><Mail size={19} color={colors.textFaint} /><View style={styles.rowCopy}><Text style={styles.rowLabel}>Email address</Text><Text numberOfLines={1} style={styles.rowValue}>{session?.user.email}</Text></View></View>
        <View style={styles.row}><Building2 size={19} color={colors.textFaint} /><View style={styles.rowCopy}><Text style={styles.rowLabel}>Workspace</Text><Text style={styles.rowValue}>{organization?.name || "Not selected"}</Text></View></View>
      </View>
      <Pressable accessibilityRole="button" onPress={() => router.push("/organizations")} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
        <View style={styles.actionIcon}><Building2 size={20} color={colors.amberText} /></View><View style={styles.actionCopy}><Text style={styles.actionTitle}>Switch workspace</Text><Text style={styles.actionHint}>Move to another organization</Text></View><ChevronRight size={18} color={colors.textFaint} />
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => router.push("/settings")} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
        <View style={styles.actionIcon}><Settings2 size={20} color={colors.amberText} /></View><View style={styles.actionCopy}><Text style={styles.actionTitle}>App settings</Text><Text style={styles.actionHint}>Appearance, notifications, security, and about</Text></View><ChevronRight size={18} color={colors.textFaint} />
      </Pressable>
      <AppButton label="Sign out" loading={signingOut} variant="danger" onPress={signOut} />
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  profileCard: { gap: 13, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  identity: { flexDirection: "row", alignItems: "center", gap: 15 },
  avatar: { width: 64, height: 64, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.amber },
  avatarImage: { width: 64, height: 64, borderRadius: 20 },
  cameraBadge: { position: "absolute", right: -4, bottom: -4, width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 9, borderWidth: 3, borderColor: colors.stage, backgroundColor: colors.amber },
  identityCopy: { flex: 1, gap: 4 },
  name: { color: colors.text, fontFamily, fontSize: 20, fontWeight: "800" },
  email: { color: colors.textMuted, fontFamily, fontSize: 13 },
  verifiedBadge: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  verifiedText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "700" },
  verifiedTextReady: { color: colors.green },
  editor: { gap: 8, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  editorLabel: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1.1 },
  editorRow: { flexDirection: "row", gap: 9 },
  nameInput: { flex: 1, minHeight: 48, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 15, paddingHorizontal: 14 },
  saveButton: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: radii.medium, backgroundColor: colors.amber },
  savingText: { color: colors.amberText, fontFamily, fontSize: 11 },
  section: { borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, overflow: "hidden" },
  row: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.stageRaised, paddingHorizontal: spacing.medium },
  rowCopy: { flex: 1, gap: 4 },
  rowLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8 },
  rowValue: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "600" },
  action: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: 13, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  actionIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.amberSoft },
  actionCopy: { flex: 1, gap: 4 },
  actionTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
  actionHint: { color: colors.textMuted, fontFamily, fontSize: 12 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.38 },
}));
