import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import Cable from "lucide-react-native/icons/cable";
import CheckCircle2 from "lucide-react-native/icons/circle-check-big";
import CirclePower from "lucide-react-native/icons/circle-power";
import RadioTower from "lucide-react-native/icons/radio-tower";
import ShieldAlert from "lucide-react-native/icons/shield-alert";
import { Redirect, useLocalSearchParams } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { ActivityIndicator, Alert, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { controlMobileDevice, getMobileDevices, type MobileDeviceAction } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type ActionValues = Record<string, number | boolean>;
type ActionDraftValues = Record<string, string | boolean>;

function initialValues(action: MobileDeviceAction): ActionDraftValues {
  return Object.fromEntries(action.params.map((param) => {
    const value = param.default ?? (param.type === "boolean" ? false : param.min ?? 0);
    return [param.id, param.type === "boolean" ? Boolean(value) : String(value)];
  }));
}

function parseValues(action: MobileDeviceAction, drafts: ActionDraftValues): { values: ActionValues } | { error: string } {
  const values: ActionValues = {};
  for (const param of action.params) {
    const draft = drafts[param.id];
    if (param.type === "boolean") {
      values[param.id] = Boolean(draft);
      continue;
    }
    const number = typeof draft === "string" && draft.trim() ? Number(draft) : Number.NaN;
    if (!Number.isFinite(number)) return { error: `${param.label} must be a number.` };
    if (param.min !== undefined && number < param.min) return { error: `${param.label} cannot be below ${param.min}.` };
    if (param.max !== undefined && number > param.max) return { error: `${param.label} cannot be above ${param.max}.` };
    values[param.id] = number;
  }
  return { values };
}

function ActionCard({ action, connected, busy, onExecute }: {
  action: MobileDeviceAction;
  connected: boolean;
  busy: boolean;
  onExecute: (action: MobileDeviceAction, params: ActionValues) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [drafts, setDrafts] = useState<ActionDraftValues>(() => initialValues(action));
  const [validationError, setValidationError] = useState<string | null>(null);
  const update = (id: string, value: string | boolean) => {
    setValidationError(null);
    setDrafts((current) => ({ ...current, [id]: value }));
  };
  const execute = () => {
    const parsed = parseValues(action, drafts);
    if ("error" in parsed) {
      setValidationError(parsed.error);
      return;
    }
    Alert.alert(
    `Send “${action.label}”?`,
    "This changes live venue equipment immediately. Confirm the values before sending.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Send now", style: "destructive", onPress: () => onExecute(action, parsed.values) },
    ],
    );
  };

  return (
    <View style={styles.actionCard}>
      <View style={styles.actionHeader}><View style={styles.actionCopy}><Text style={styles.actionName}>{action.label}</Text><Text style={styles.category}>{action.category}</Text></View><ShieldAlert color={colors.amberText} size={17} /></View>
      {action.params.map((param) => (
        <View key={param.id} style={styles.fieldRow}>
          <View style={styles.fieldCopy}><Text style={styles.fieldLabel}>{param.label}</Text>{param.type === "number" && param.min !== undefined && param.max !== undefined ? <Text style={styles.range}>{param.min}–{param.max}</Text> : null}</View>
          {param.type === "boolean" ? (
            <Switch accessibilityLabel={param.label} disabled={!connected || busy} onValueChange={(value) => update(param.id, value)} thumbColor={drafts[param.id] ? colors.amber : colors.textMuted} trackColor={{ false: colors.border, true: colors.amberSoft }} value={Boolean(drafts[param.id])} />
          ) : (
            <TextInput accessibilityLabel={param.label} editable={connected && !busy} keyboardType="decimal-pad" onChangeText={(value) => update(param.id, value)} selectTextOnFocus style={[styles.numberInput, validationError && styles.numberInputError]} value={String(drafts[param.id])} />
          )}
        </View>
      ))}
      {validationError ? <Text accessibilityRole="alert" style={styles.validationError}>{validationError}</Text> : null}
      <AppButton disabled={!connected || busy} label={busy ? "Sending…" : connected ? `Send ${action.label}` : "Connect device first"} onPress={execute} variant="secondary" />
    </View>
  );
}

export default function DeviceControlScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { deviceId } = useLocalSearchParams<{ deviceId: string }>();
  const { data: organization } = authClient.useActiveOrganization();
  const [connected, setConnected] = useState(false);
  const query = useQuery({
    queryKey: ["mobile-devices", organization?.id],
    queryFn: () => getMobileDevices(organization!.id),
    enabled: Boolean(organization?.id),
  });
  const device = useMemo(() => query.data?.devices.find((candidate) => candidate.id === deviceId), [deviceId, query.data]);
  const connection = useMutation({
    mutationFn: (operation: "connect" | "disconnect") => controlMobileDevice({ orgId: organization!.id, deviceId, operation }),
    onSuccess: async (_, operation) => {
      setConnected(operation === "connect");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Device connection failed", error.message),
  });
  const command = useMutation({
    mutationFn: ({ action, params }: { action: MobileDeviceAction; params: ActionValues }) => controlMobileDevice({ orgId: organization!.id, deviceId, operation: "action", actionId: action.id, params }),
    onSuccess: async () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    onError: (error) => Alert.alert("Command failed", error.message),
  });

  if (!organization) return <Redirect href="/organizations" />;
  if (query.isPending) return <Page><ActivityIndicator color={colors.amber} size="large" /></Page>;
  if (query.error) return <Page eyebrow="EQUIPMENT" title="Device unavailable"><Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text></Page>;
  if (!device || !device.enabled || device.controls.length === 0) return <Page eyebrow="EQUIPMENT" title="Device unavailable"><Text style={styles.empty}>This device is disabled, missing, or does not expose safe native controls.</Text></Page>;

  return (
    <Page eyebrow={device.category} title={device.name}>
      <View style={styles.connectionCard}>
        <View style={styles.deviceIcon}><Cable color={colors.amber} size={23} /></View>
        <View style={styles.connectionCopy}><Text style={styles.adapter}>{device.adapterType}</Text><View style={styles.statusRow}>{connected ? <CheckCircle2 color={colors.green} size={14} /> : <CirclePower color={colors.textFaint} size={14} />}<Text style={[styles.status, connected && styles.statusOnline]}>{connected ? "CONNECTED" : "NOT CONNECTED"}</Text></View></View>
      </View>
      <View style={styles.bridgeNote}><RadioTower color={colors.amber} size={18} /><Text style={styles.bridgeText}>Remote commands travel through your organization’s venue Bridge. ShowPilot never sends device credentials to this app.</Text></View>
      <AppButton label={connection.isPending ? (connected ? "Disconnecting…" : "Connecting…") : connected ? "Disconnect device" : "Connect through venue Bridge"} loading={connection.isPending} onPress={() => connection.mutate(connected ? "disconnect" : "connect")} variant={connected ? "danger" : "primary"} />
      <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>LIVE CONTROLS</Text><Text style={styles.sectionCount}>{device.controls.length}</Text></View>
      <View style={styles.actionList}>{device.controls.map((action) => <ActionCard action={action} busy={command.isPending} connected={connected} key={action.id} onExecute={(selectedAction, params) => command.mutate({ action: selectedAction, params })} />)}</View>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  connectionCard: { flexDirection: "row", alignItems: "center", gap: 13, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  deviceIcon: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: colors.amberSoft },
  connectionCopy: { flex: 1, gap: 7 },
  adapter: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800", textTransform: "uppercase" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  status: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  statusOnline: { color: colors.green },
  bridgeNote: { flexDirection: "row", alignItems: "flex-start", gap: 10, borderRadius: radii.medium, backgroundColor: colors.amberSoft, padding: spacing.medium },
  bridgeText: { flex: 1, color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  sectionTitle: { color: colors.textFaint, fontFamily, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  sectionCount: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.panelStrong, color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "900", paddingHorizontal: 8, paddingVertical: 3 },
  actionList: { gap: 12 },
  actionCard: { gap: 13, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  actionHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  actionCopy: { flex: 1, gap: 4 },
  actionName: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  category: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "900", textTransform: "uppercase" },
  fieldRow: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderTopColor: colors.borderSoft, paddingTop: 12 },
  fieldCopy: { flex: 1, gap: 3 },
  fieldLabel: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "700" },
  range: { color: colors.textFaint, fontFamily, fontSize: 9 },
  numberInput: { width: 88, minHeight: 42, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong, color: colors.text, fontFamily, fontSize: 15, fontWeight: "700", paddingHorizontal: 12, textAlign: "right" },
  numberInputError: { borderColor: colors.red },
  validationError: { color: colors.red, fontFamily, fontSize: 12, lineHeight: 18 },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
}));
