import { useCallback, useEffect, useState, type ReactNode } from "react";
import Constants from "expo-constants";
import { Redirect, useFocusEffect } from "expo-router";
import BellRing from "lucide-react-native/icons/bell-ring";
import Check from "lucide-react-native/icons/check";
import ExternalLink from "lucide-react-native/icons/external-link";
import FileText from "lucide-react-native/icons/file-text";
import KeyRound from "lucide-react-native/icons/key-round";
import LifeBuoy from "lucide-react-native/icons/life-buoy";
import Moon from "lucide-react-native/icons/moon";
import Server from "lucide-react-native/icons/server";
import ShieldCheck from "lucide-react-native/icons/shield-check";
import Smartphone from "lucide-react-native/icons/smartphone";
import Sun from "lucide-react-native/icons/sun";
import Trash2 from "lucide-react-native/icons/trash-2";
import { Alert, AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";
import { saveMobilePushToken } from "@/lib/mobile-api";
import {
  enableNativeNotifications,
  getNativeNotificationPermissionState,
  isNativePushConfigured,
  type NativeNotificationPermissionState,
} from "@/lib/native-notifications";
import {
  createThemedStyles,
  fontFamily,
  radii,
  setAppThemePreference,
  spacing,
  type ThemePreference,
  useAppTheme,
} from "@/theme/tokens";

const appearanceOptions: {
  value: ThemePreference;
  label: string;
  description: string;
  icon: "system" | "light" | "dark";
}[] = [
  { value: "system", label: "System", description: "Match this device", icon: "system" },
  { value: "light", label: "Light", description: "Warm, low-glare canvas", icon: "light" },
  { value: "dark", label: "Dark", description: "Built for control rooms", icon: "dark" },
];

function notificationStatusCopy(state: NativeNotificationPermissionState | null, pushConfigured: boolean) {
  if (!state) return { label: "Checking", detail: "Reading this device’s notification permission." };
  if (state.status === "granted" && pushConfigured) {
    return { label: "Permission on", detail: "ShowPilot has OS permission. Remote registration refreshes whenever the app opens." };
  }
  if (state.status === "granted") {
    return { label: "Permission on", detail: "Remote alert registration will finish in the signed ShowPilot build." };
  }
  if (state.status === "denied") {
    return { label: "Blocked", detail: "ShowPilot alerts are turned off in this device’s settings." };
  }
  if (state.status === "undetermined") {
    return { label: "Not set up", detail: "Turn on alerts for assignments, mentions, and live operations." };
  }
  return { label: "Signed app required", detail: "Native notifications are available on physical iOS and Android devices." };
}

export default function SettingsScreen() {
  const { colors, preference } = useAppTheme();
  const styles = useStyles();
  const { data: session, isPending } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const [permission, setPermission] = useState<NativeNotificationPermissionState | null>(null);
  const [updatingNotifications, setUpdatingNotifications] = useState(false);
  const appVersion = Constants.expoConfig?.version ?? "development";
  const pushConfigured = isNativePushConfigured();
  const platformLabel = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : "Web preview";
  const apiLabel = SHOWPILOT_URL.replace(/^https?:\/\//, "");
  const notificationCopy = notificationStatusCopy(permission, pushConfigured);

  const refreshPermission = useCallback(async () => {
    setPermission(await getNativeNotificationPermissionState());
  }, []);

  useFocusEffect(useCallback(() => {
    void refreshPermission();
  }, [refreshPermission]));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshPermission();
    });
    return () => subscription.remove();
  }, [refreshPermission]);

  async function selectAppearance(nextPreference: ThemePreference) {
    try {
      await setAppThemePreference(nextPreference);
    } catch {
      Alert.alert("Appearance not saved", "The new appearance is active for now, but could not be saved on this device.");
    }
  }

  async function configureNotifications() {
    if (permission?.status === "denied" && !permission.canAskAgain) {
      await Linking.openSettings();
      return;
    }

    setUpdatingNotifications(true);
    try {
      const result = await enableNativeNotifications();
      const nativePlatform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : null;
      if (result.token && organization?.id && nativePlatform) {
        await saveMobilePushToken(organization.id, result.token, nativePlatform);
      }
      await refreshPermission();
      Alert.alert(
        result.token ? "Notifications are ready" : "Notification permission is on",
        result.token
          ? "This device can receive ShowPilot assignments, mentions, and operational alerts."
          : "Remote alert registration will finish when the signed ShowPilot build is connected to its notification service.",
      );
    } catch (caught) {
      await refreshPermission();
      Alert.alert("Notifications not enabled", caught instanceof Error ? caught.message : "Please try again.");
    } finally {
      setUpdatingNotifications(false);
    }
  }

  async function openExternal(path: string) {
    try {
      await Linking.openURL(`${SHOWPILOT_URL}${path}`);
    } catch {
      Alert.alert("Could not open this page", "Check your connection and try again.");
    }
  }

  if (isPending) return <LoadingView label="Loading settings…" />;
  if (!session) return <Redirect href="/sign-in" />;

  return (
    <Page eyebrow="YOUR APP" title="Settings" maxWidth={720}>
      <SettingsSection title="Appearance" description="Choose the canvas that feels best in daylight, backstage, or the control room.">
        <View accessibilityRole="radiogroup" style={styles.appearanceGrid}>
          {appearanceOptions.map((option) => {
            const selected = preference === option.value;
            const icon = option.icon === "light"
              ? <Sun size={20} color={selected ? colors.black : colors.textMuted} />
              : option.icon === "dark"
                ? <Moon size={20} color={selected ? colors.black : colors.textMuted} />
                : <Smartphone size={20} color={selected ? colors.black : colors.textMuted} />;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                key={option.value}
                onPress={() => selectAppearance(option.value)}
                style={({ pressed }) => [styles.appearanceOption, selected && styles.appearanceOptionSelected, pressed && styles.pressed]}
              >
                <View style={[styles.appearanceIcon, selected && styles.appearanceIconSelected]}>{icon}</View>
                <View style={styles.appearanceCopy}>
                  <Text style={[styles.appearanceLabel, selected && styles.appearanceLabelSelected]}>{option.label}</Text>
                  <Text style={[styles.appearanceDescription, selected && styles.appearanceDescriptionSelected]}>{option.description}</Text>
                </View>
                {selected ? <Check size={17} color={colors.black} /> : null}
              </Pressable>
            );
          })}
        </View>
      </SettingsSection>

      <SettingsSection title="Notifications" description="Device permission is personal. Workspace alert rules remain controlled by your organization’s admins.">
        <View style={styles.notificationCard}>
          <View style={styles.notificationTop}>
            <View style={styles.sectionIcon}><BellRing size={21} color={colors.amberText} /></View>
            <View style={styles.notificationCopy}>
              <View style={styles.statusLine}>
                <Text style={styles.cardTitle}>Device alerts</Text>
                <View style={[styles.statusPill, permission?.status === "granted" && styles.statusPillReady, permission?.status === "denied" && styles.statusPillBlocked]}>
                  <Text style={[styles.statusText, permission?.status === "granted" && styles.statusTextReady, permission?.status === "denied" && styles.statusTextBlocked]}>{notificationCopy.label}</Text>
                </View>
              </View>
              <Text style={styles.cardDescription}>{notificationCopy.detail}</Text>
            </View>
          </View>
          {permission?.status === "undetermined" || permission?.status === "denied" ? (
            <AppButton
              label={permission.status === "denied" && !permission.canAskAgain ? "Open device settings" : "Turn on notifications"}
              loading={updatingNotifications}
              variant="secondary"
              onPress={configureNotifications}
            />
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection title="Account & security" description="Security changes open on ShowPilot’s secure account pages.">
        <SettingsLink
          icon={<KeyRound size={20} color={colors.amberText} />}
          title="Change password"
          description={`Send a secure reset link to ${session.user.email}`}
          onPress={() => openExternal("/forgot-password")}
        />
        <View style={styles.verifiedRow}>
          <ShieldCheck size={20} color={session.user.emailVerified ? colors.green : colors.amberText} />
          <View style={styles.linkCopy}>
            <Text style={styles.linkTitle}>Email verification</Text>
            <Text style={styles.linkDescription}>{session.user.emailVerified ? "Verified" : "Verification still required"}</Text>
          </View>
        </View>
        <SettingsLink
          icon={<Trash2 size={20} color={colors.red} />}
          title="Delete account"
          description="Permanently remove your ShowPilot account and personal data"
          onPress={() => openExternal("/delete-account")}
        />
      </SettingsSection>

      <SettingsSection title="Legal">
        <SettingsLink icon={<LifeBuoy size={20} color={colors.textMuted} />} title="Support" onPress={() => openExternal("/support")} />
        <SettingsLink icon={<FileText size={20} color={colors.textMuted} />} title="Terms of Service" onPress={() => openExternal("/terms")} />
        <SettingsLink icon={<ShieldCheck size={20} color={colors.textMuted} />} title="Privacy Policy" onPress={() => openExternal("/privacy")} />
      </SettingsSection>

      <SettingsSection title="About">
        <View style={styles.aboutCard}>
          <AboutRow icon={<Smartphone size={17} color={colors.textFaint} />} label="App" value={`ShowPilot ${appVersion} · ${platformLabel}`} />
          <AboutRow icon={<Server size={17} color={colors.textFaint} />} label="Service" value={apiLabel} />
        </View>
      </SettingsSection>
    </Page>
  );
}

function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {description ? <Text style={styles.sectionDescription}>{description}</Text> : null}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function SettingsLink({ icon, title, description, onPress }: { icon: ReactNode; title: string; description?: string; onPress: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="link" onPress={onPress} style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}>
      {icon}
      <View style={styles.linkCopy}>
        <Text style={styles.linkTitle}>{title}</Text>
        {description ? <Text style={styles.linkDescription}>{description}</Text> : null}
      </View>
      <ExternalLink size={16} color={colors.textFaint} />
    </Pressable>
  );
}

function AboutRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.aboutRow}>
      {icon}
      <Text style={styles.aboutLabel}>{label}</Text>
      <Text selectable style={styles.aboutValue}>{value}</Text>
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  section: { gap: 11 },
  sectionHeading: { gap: 5 },
  sectionTitle: { color: colors.text, fontFamily, fontSize: 17, fontWeight: "800" },
  sectionDescription: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 19 },
  sectionBody: { gap: 10 },
  appearanceGrid: { gap: 9 },
  appearanceOption: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: spacing.medium, paddingVertical: 11 },
  appearanceOptionSelected: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amber },
  appearanceIcon: { width: 39, height: 39, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.stageRaised },
  appearanceIconSelected: { backgroundColor: "rgba(9, 9, 9, 0.10)" },
  appearanceCopy: { flex: 1, gap: 3 },
  appearanceLabel: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  appearanceLabelSelected: { color: colors.black },
  appearanceDescription: { color: colors.textMuted, fontFamily, fontSize: 12 },
  appearanceDescriptionSelected: { color: "rgba(9, 9, 9, 0.67)" },
  notificationCard: { gap: spacing.medium, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.medium },
  notificationTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sectionIcon: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.amberSoft },
  notificationCopy: { flex: 1, gap: 7 },
  statusLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  cardDescription: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 19 },
  statusPill: { borderRadius: radii.pill, backgroundColor: colors.panelStrong, paddingHorizontal: 9, paddingVertical: 5 },
  statusPillReady: { backgroundColor: colors.greenSoft },
  statusPillBlocked: { backgroundColor: colors.redSoft },
  statusText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.55 },
  statusTextReady: { color: colors.green },
  statusTextBlocked: { color: colors.red },
  linkRow: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: 13, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  verifiedRow: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: 13, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  linkCopy: { flex: 1, minWidth: 0, gap: 4 },
  linkTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
  linkDescription: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  aboutCard: { borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, overflow: "hidden" },
  aboutRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: spacing.medium },
  aboutLabel: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "700" },
  aboutValue: { flex: 1, color: colors.text, fontFamily, fontSize: 12, textAlign: "right" },
  pressed: { opacity: 0.72 },
}));
