import { useState } from "react";
import { BellRing, Building2, Camera, LogOut, Mail, Save, Shield, UserRound } from "lucide-react-native";
import { Alert, Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { saveMobilePushToken, uploadMobileAvatar } from "@/lib/mobile-api";
import { enableNativeNotifications, getNativePushToken } from "@/lib/native-notifications";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function ProfileScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: session, refetch: refetchSession } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const [enablingNotifications, setEnablingNotifications] = useState(false);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const name = nameDraft ?? session?.user.name ?? "";
  const appVersion = Constants.expoConfig?.version ?? "development";

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
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new Error("Allow photo access to choose a profile picture.");
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
      const uploaded = await uploadMobileAvatar({ uri: processed.uri, name: "avatar.jpg", type: "image/jpeg" });
      const result = await authClient.updateUser({ image: uploaded.url });
      if (result.error) throw new Error(result.error.message || "Photo could not be saved.");
      await refetchSession();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert("Photo not saved", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setSavingAvatar(false);
    }
  }

  async function enableNotifications() {
    setEnablingNotifications(true);
    try {
      const result = await enableNativeNotifications();
      if (result.token && organization?.id && (Platform.OS === "ios" || Platform.OS === "android")) {
        await saveMobilePushToken(organization.id, result.token, Platform.OS);
      }
      Alert.alert("Notifications enabled", result.token ? "This device is ready for ShowPilot push alerts." : "Permission is enabled. Push registration will finish when the signed app build is linked to EAS.");
    } catch (error) {
      Alert.alert("Notifications not enabled", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setEnablingNotifications(false);
    }
  }

  async function signOut() {
    const token = await getNativePushToken().catch(() => null);
    if (token && organization?.id && (Platform.OS === "ios" || Platform.OS === "android")) {
      await saveMobilePushToken(organization.id, token, Platform.OS, false).catch(() => undefined);
    }
    await authClient.signOut();
    await Haptics.selectionAsync();
    router.replace("/sign-in");
  }

  return (
    <Page eyebrow="ACCOUNT" title="Profile">
      <View style={styles.identity}>
        <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo" disabled={savingAvatar} onPress={chooseAvatar} style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}>
          {session?.user.image ? <Image source={{ uri: session.user.image }} style={styles.avatarImage} /> : <UserRound size={31} color={colors.black} />}
          <View style={styles.cameraBadge}><Camera size={12} color={colors.black} /></View>
        </Pressable>
        <View style={styles.identityCopy}><Text style={styles.name}>{session?.user.name || "ShowPilot user"}</Text><Text style={styles.email}>{session?.user.email}</Text></View>
      </View>
      <View style={styles.editor}>
        <Text style={styles.editorLabel}>DISPLAY NAME</Text>
        <View style={styles.editorRow}>
          <TextInput accessibilityLabel="Display name" autoCapitalize="words" maxLength={80} value={name} onChangeText={setNameDraft} placeholder="Your name" placeholderTextColor={colors.textFaint} style={styles.nameInput} />
          <Pressable accessibilityRole="button" accessibilityLabel="Save display name" disabled={savingName || !name.trim() || name.trim() === session?.user.name} onPress={saveName} style={({ pressed }) => [styles.saveButton, (savingName || !name.trim() || name.trim() === session?.user.name) && styles.disabled, pressed && styles.pressed]}><Save size={18} color={colors.black} /></Pressable>
        </View>
        {savingAvatar ? <Text style={styles.savingText}>Preparing and saving photo…</Text> : null}
      </View>
      <View style={styles.section}>
        <View style={styles.row}><Mail size={19} color={colors.textFaint} /><View style={styles.rowCopy}><Text style={styles.rowLabel}>Email</Text><Text style={styles.rowValue}>{session?.user.email}</Text></View></View>
        <View style={styles.row}><Building2 size={19} color={colors.textFaint} /><View style={styles.rowCopy}><Text style={styles.rowLabel}>Workspace</Text><Text style={styles.rowValue}>{organization?.name || "Not selected"}</Text></View></View>
        <View style={styles.row}><Shield size={19} color={colors.textFaint} /><View style={styles.rowCopy}><Text style={styles.rowLabel}>Security</Text><Text style={styles.rowValue}>Protected native session</Text></View></View>
      </View>
      <Pressable onPress={() => router.push("/organizations")} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
        <Building2 size={20} color={colors.amberText} /><View style={styles.actionCopy}><Text style={styles.actionTitle}>Switch workspace</Text><Text style={styles.actionHint}>Move to another organization</Text></View>
      </Pressable>
      <Pressable onPress={enableNotifications} disabled={enablingNotifications} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
        <BellRing size={20} color={colors.amberText} /><View style={styles.actionCopy}><Text style={styles.actionTitle}>{enablingNotifications ? "Enabling…" : "Enable native notifications"}</Text><Text style={styles.actionHint}>Assignments, mentions, and operational alerts</Text></View>
      </Pressable>
      <AppButton label="Sign out" variant="danger" onPress={signOut} />
      <View style={styles.version}><LogOut size={14} color={colors.textFaint} /><Text style={styles.versionText}>ShowPilot Mobile {appVersion}</Text></View>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  identity: { flexDirection: "row", alignItems: "center", gap: 15 },
  avatar: { width: 64, height: 64, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.amber },
  avatarImage: { width: 64, height: 64, borderRadius: 20 },
  cameraBadge: { position: "absolute", right: -4, bottom: -4, width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 9, borderWidth: 3, borderColor: colors.stage, backgroundColor: colors.amber },
  identityCopy: { flex: 1, gap: 4 },
  name: { color: colors.text, fontFamily, fontSize: 20, fontWeight: "800" },
  email: { color: colors.textMuted, fontFamily, fontSize: 13 },
  editor: { gap: 8 },
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
  actionCopy: { flex: 1, gap: 4 },
  actionTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
  actionHint: { color: colors.textMuted, fontFamily, fontSize: 12 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.38 },
  version: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  versionText: { color: colors.textFaint, fontFamily, fontSize: 11 },
}));
