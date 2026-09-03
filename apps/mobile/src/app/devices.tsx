import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Cable from "lucide-react-native/icons/cable";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import CirclePower from "lucide-react-native/icons/circle-power";
import Pencil from "lucide-react-native/icons/pencil";
import Plus from "lucide-react-native/icons/plus";
import RadioTower from "lucide-react-native/icons/radio-tower";
import Search from "lucide-react-native/icons/search";
import Trash2 from "lucide-react-native/icons/trash-2";
import X from "lucide-react-native/icons/x";
import { Redirect, router } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { LoadingView } from "@/components/loading-view";
import { authClient } from "@/lib/auth-client";
import {
  createMobileDevice,
  getMobileDevices,
  removeMobileDevice,
  updateMobileDevice,
  type MobileDevice,
  type MobileDeviceAdapter,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

function DeviceEditor({ adapters, device, onClose, orgId }: {
  adapters: MobileDeviceAdapter[];
  device: MobileDevice | null;
  onClose: () => void;
  orgId: string;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const initialAdapterType = device?.adapterType ?? adapters[0]?.adapterType ?? "";
  const initialAdapter = adapters.find((candidate) => candidate.adapterType === initialAdapterType);
  const [adapterType, setAdapterType] = useState(initialAdapterType);
  const [name, setName] = useState(device?.name ?? adapters[0]?.displayName ?? "");
  const [enabled, setEnabled] = useState(device?.enabled ?? true);
  const [settings, setSettings] = useState<Record<string, string>>(() => Object.fromEntries(
    device
      ? device.configuration.map((field) => [field.key, field.value])
      : (initialAdapter?.fields ?? []).filter((field) => field.type === "select" && field.options[0]).map((field) => [field.key, field.options[0].value]),
  ));
  const adapter = adapters.find((candidate) => candidate.adapterType === adapterType);
  const configuration = device?.adapterType === adapterType ? device.configuration : adapter?.fields.map((field) => ({ ...field, value: "", secretConfigured: false })) ?? [];
  const mutation = useMutation({
    mutationFn: () => {
      if (!name.trim() || !adapterType) throw new Error("Enter a name and choose an adapter.");
      return device
        ? updateMobileDevice({ orgId, deviceId: device.id, name: name.trim(), adapterType, enabled, settings })
        : createMobileDevice({ orgId, name: name.trim(), adapterType, enabled, settings });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mobile-devices", orgId] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    },
    onError: (error) => Alert.alert("Device not saved", error.message),
  });

  function selectAdapter(next: MobileDeviceAdapter) {
    setAdapterType(next.adapterType);
    setSettings(Object.fromEntries(
      device?.adapterType === next.adapterType
        ? device.configuration.map((field) => [field.key, field.value])
        : next.fields.filter((field) => field.type === "select" && field.options[0]).map((field) => [field.key, field.options[0].value]),
    ));
    if (!device || name === adapter?.displayName) setName(next.displayName);
  }

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <Page scroll={false}>
        <View style={styles.editorHeader}><View style={styles.editorHeaderCopy}><Text style={styles.editorEyebrow}>{device ? "EDIT DEVICE" : "NEW DEVICE"}</Text><Text style={styles.editorTitle}>{device?.name ?? "Connect equipment"}</Text></View><Pressable accessibilityLabel="Close device editor" onPress={onClose} style={styles.iconButton}><X color={colors.textMuted} size={21} /></Pressable></View>
        <ScrollView contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled">
          <Text style={styles.fieldHeading}>ADAPTER</Text>
          <View style={styles.adapterGrid}>{adapters.map((candidate) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: adapterType === candidate.adapterType }} key={candidate.adapterType} onPress={() => selectAdapter(candidate)} style={[styles.adapterChoice, adapterType === candidate.adapterType && styles.adapterChoiceActive]}><Text style={[styles.adapterName, adapterType === candidate.adapterType && styles.adapterNameActive]}>{candidate.displayName}</Text><Text style={styles.adapterMeta}>{candidate.category} · {candidate.connectivity === "bridge-required" ? "Bridge" : "Network"}</Text></Pressable>)}</View>
          {adapter ? <Text style={styles.adapterDescription}>{adapter.description}</Text> : null}
          <Text style={styles.fieldHeading}>DEVICE NAME</Text>
          <TextInput accessibilityLabel="Device name" maxLength={200} onChangeText={setName} placeholder="Main switcher" placeholderTextColor={colors.textFaint} style={styles.editorInput} value={name} />
          {configuration.map((field) => <View key={field.key} style={styles.configField}>
            <View style={styles.configLabelRow}><Text style={styles.configLabel}>{field.label}{field.required ? " *" : ""}</Text>{field.secretConfigured ? <Text style={styles.savedSecret}>SAVED</Text> : null}</View>
            {field.type === "select" ? <View accessibilityRole="radiogroup" style={styles.optionRow}>{field.options.map((option) => { const selected = (settings[field.key] || field.value) === option.value; return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} key={option.value} onPress={() => setSettings((current) => ({ ...current, [field.key]: option.value }))} style={[styles.option, selected && styles.optionActive]}><Text style={[styles.optionText, selected && styles.optionTextActive]}>{option.label}</Text></Pressable>; })}</View> : <TextInput accessibilityLabel={field.label} keyboardType={field.type === "number" ? "number-pad" : "default"} maxLength={4096} onChangeText={(value) => setSettings((current) => ({ ...current, [field.key]: value }))} placeholder={field.secretConfigured ? "Saved — leave blank to keep" : field.placeholder || field.label} placeholderTextColor={colors.textFaint} secureTextEntry={field.type === "password"} style={styles.editorInput} value={settings[field.key] ?? field.value} />}
          </View>)}
          <View style={styles.enabledRow}><View style={styles.enabledCopy}><Text style={styles.enabledTitle}>Device enabled</Text><Text style={styles.enabledDescription}>Disabled devices remain configured but cannot receive commands.</Text></View><Switch accessibilityLabel="Device enabled" onValueChange={setEnabled} thumbColor={enabled ? colors.amber : colors.textMuted} trackColor={{ false: colors.border, true: colors.amberSoft }} value={enabled} /></View>
          <AppButton disabled={mutation.isPending || !name.trim() || !adapterType} label={mutation.isPending ? "Saving device…" : device ? "Save device" : "Add device"} loading={mutation.isPending} onPress={() => mutation.mutate()} />
        </ScrollView>
      </Page>
    </Modal>
  );
}

export default function DevicesScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<MobileDevice | null>(null);
  const query = useQuery({ queryKey: ["mobile-devices", organization?.id], queryFn: () => getMobileDevices(organization!.id), enabled: Boolean(organization?.id), refetchInterval: 10_000 });
  const removeMutation = useMutation({
    mutationFn: (deviceId: string) => removeMobileDevice({ orgId: organization!.id, deviceId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mobile-devices", organization?.id] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Device not removed", error.message),
  });
  const devices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (query.data?.devices ?? []).filter((device) => !needle || `${device.name} ${device.category} ${device.adapterType}`.toLowerCase().includes(needle));
  }, [query.data?.devices, search]);
  if (organizationPending) return <LoadingView label="Opening devices…" />;
  if (!organization) return <Redirect href="/organizations" />;

  function openEditor(device: MobileDevice | null) {
    setEditingDevice(device);
    setEditorOpen(true);
  }

  function confirmRemove(device: MobileDevice) {
    Alert.alert("Remove device?", `${device.name} and its configuration will be deleted permanently.`, [
      { text: "Keep device", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => removeMutation.mutate(device.id) },
    ]);
  }

  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="EQUIPMENT" title="Devices" scroll={false} action={<Pressable accessibilityLabel="Add device" accessibilityRole="button" onPress={() => openEditor(null)} style={styles.addButton}><Plus color={colors.black} size={20} /></Pressable>}>
      <FlatList
        contentContainerStyle={styles.list}
        data={devices}
        initialNumToRender={10}
        keyExtractor={(device) => device.id}
        ListHeaderComponent={(
          <View style={styles.listHeader}>
            <View style={[styles.bridgeNote, query.data?.bridge.online ? styles.bridgeOnline : styles.bridgeOffline]}><RadioTower color={query.data?.bridge.online ? colors.green : colors.red} size={19} /><View style={styles.bridgeCopy}><Text style={styles.bridgeTitle}>{query.data?.bridge.online ? "Venue Bridge online" : "Venue Bridge offline"}</Text><Text style={styles.bridgeText}>{query.data?.bridge.online ? `${query.data.bridge.version ? `Version ${query.data.bridge.version} · ` : ""}${query.data.bridge.deviceCount} connected ${query.data.bridge.deviceCount === 1 ? "device" : "devices"}${query.data.bridge.uptime !== null ? ` · Up ${Math.max(1, Math.floor(query.data.bridge.uptime / 60))} min` : ""}` : "Start the Bridge on a trusted venue computer before using remote controls."}</Text></View></View>
            <View style={styles.fleetStats}><View style={styles.fleetStat}><Text style={styles.fleetValue}>{query.data?.devices.length ?? 0}</Text><Text style={styles.fleetLabel}>CONFIGURED</Text></View><View style={styles.fleetStat}><Text style={[styles.fleetValue, styles.onlineValue]}>{query.data?.devices.filter((device) => device.connected).length ?? 0}</Text><Text style={styles.fleetLabel}>CONNECTED</Text></View><View style={styles.fleetStat}><Text style={styles.fleetValue}>{new Set(query.data?.devices.map((device) => device.adapterType)).size}</Text><Text style={styles.fleetLabel}>ADAPTERS</Text></View></View>
            <View style={styles.searchBox}><Search color={colors.textFaint} size={16} /><TextInput accessibilityLabel="Search devices" onChangeText={setSearch} placeholder="Search devices or adapters" placeholderTextColor={colors.textFaint} style={styles.searchInput} value={search} />{search ? <Pressable accessibilityLabel="Clear device search" onPress={() => setSearch("")}><X color={colors.textMuted} size={17} /></Pressable> : null}</View>
            {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
            {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
          </View>
        )}
        ListEmptyComponent={query.data && !query.isPending ? <View style={styles.emptyState}><Text style={styles.empty}>{search ? "No devices match this search." : "No devices are configured for this workspace."}</Text>{!search ? <AppButton label="Add the first device" onPress={() => openEditor(null)} variant="secondary" /> : null}</View> : null}
        maxToRenderPerBatch={10}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: device }) => {
          const controllable = device.enabled && device.controls.length > 0;
          return <View style={styles.card}><Pressable accessibilityRole={controllable ? "button" : undefined} accessibilityLabel={controllable ? `Control ${device.name}` : undefined} disabled={!controllable} onPress={() => router.push({ pathname: "/device/[deviceId]", params: { deviceId: device.id } })} style={({ pressed }) => [styles.cardMain, pressed && styles.pressed]}><View style={styles.icon}><Cable color={device.enabled ? colors.amber : colors.textFaint} size={20} /></View><View style={styles.copy}><Text style={styles.name}>{device.name}</Text><Text style={styles.meta}>{device.category} · {device.adapterType || "native adapter"}</Text><Text style={styles.controlMeta}>{controllable ? `${device.controls.length} live controls` : "Setup and monitoring"}</Text></View><View style={styles.state}><CirclePower size={11} color={device.connected ? colors.green : device.enabled ? colors.amberText : colors.textFaint} /><Text style={[styles.stateText, device.connected && styles.stateTextEnabled]}>{device.connected ? "CONNECTED" : device.enabled ? "READY" : "OFF"}</Text>{controllable ? <ChevronRight color={colors.textFaint} size={17} /> : null}</View></Pressable><View style={styles.cardActions}><Pressable accessibilityLabel={`Edit ${device.name}`} onPress={() => openEditor(device)} style={styles.iconButton}><Pencil color={colors.textMuted} size={16} /></Pressable><Pressable accessibilityLabel={`Remove ${device.name}`} disabled={removeMutation.isPending} onPress={() => confirmRemove(device)} style={styles.iconButton}><Trash2 color={colors.red} size={16} /></Pressable></View></View>;
        }}
        windowSize={7}
      />
      {editorOpen && query.data ? <DeviceEditor adapters={query.data.adapters} device={editingDevice} key={editingDevice?.id ?? "new"} onClose={() => setEditorOpen(false)} orgId={organization.id} /> : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  addButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amber },
  bridgeNote: { flexDirection: "row", gap: 12, borderRadius: radii.medium, borderWidth: 1, padding: spacing.medium },
  bridgeOnline: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  bridgeOffline: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  bridgeCopy: { flex: 1, gap: 5 },
  bridgeTitle: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  bridgeText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  fleetStats: { flexDirection: "row", overflow: "hidden", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  fleetStat: { flex: 1, alignItems: "center", gap: 3, borderRightWidth: 1, borderRightColor: colors.border, paddingVertical: 10 },
  fleetValue: { color: colors.text, fontFamily, fontSize: 17, fontWeight: "900" },
  onlineValue: { color: colors.green },
  fleetLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.7 },
  searchBox: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 13 },
  list: { gap: 10, paddingBottom: spacing.large },
  listHeader: { gap: spacing.medium, marginBottom: 2 },
  card: { overflow: "hidden", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  cardMain: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.medium },
  cardActions: { flexDirection: "row", justifyContent: "flex-end", gap: 6, borderTopWidth: 1, borderTopColor: colors.borderSoft, padding: 7 },
  iconButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  icon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.panelStrong },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  name: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  meta: { color: colors.textMuted, fontFamily, fontSize: 11, textTransform: "capitalize" },
  state: { flexDirection: "row", alignItems: "center", gap: 4 },
  stateText: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900" },
  stateTextEnabled: { color: colors.green },
  controlMeta: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  pressed: { opacity: 0.72 },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  emptyState: { gap: 12, alignItems: "center", paddingVertical: 30 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center" },
  editorHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  editorHeaderCopy: { flex: 1, gap: 3 },
  editorEyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  editorTitle: { color: colors.text, fontFamily, fontSize: 20, fontWeight: "900" },
  editorContent: { gap: 12, paddingBottom: 36 },
  fieldHeading: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.1, marginTop: 5 },
  adapterGrid: { gap: 7 },
  adapterChoice: { gap: 3, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12 },
  adapterChoiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  adapterName: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  adapterNameActive: { color: colors.amberText },
  adapterMeta: { color: colors.textMuted, fontFamily, fontSize: 11, textTransform: "capitalize" },
  adapterDescription: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  editorInput: { minHeight: 46, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 13, paddingHorizontal: 12 },
  configField: { gap: 7 },
  configLabelRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  configLabel: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "800" },
  savedSecret: { color: colors.green, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.6 },
  optionRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  option: { minHeight: 38, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12 },
  optionActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  optionText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "700" },
  optionTextActive: { color: colors.amberText },
  enabledRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12 },
  enabledCopy: { flex: 1, gap: 4 },
  enabledTitle: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  enabledDescription: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 14 },
}));
