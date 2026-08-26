import { useQuery } from "@tanstack/react-query";
import Cable from "lucide-react-native/icons/cable";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import CirclePower from "lucide-react-native/icons/circle-power";
import RadioTower from "lucide-react-native/icons/radio-tower";
import { Redirect, router } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { getMobileDevices } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function DevicesScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: organization } = authClient.useActiveOrganization();
  const query = useQuery({ queryKey: ["mobile-devices", organization?.id], queryFn: () => getMobileDevices(organization!.id), enabled: Boolean(organization?.id), refetchInterval: 20_000 });
  if (!organization) return <Redirect href="/organizations" />;
  return (
    <Page eyebrow="EQUIPMENT" title="Devices" refreshing={query.isRefetching} onRefresh={query.refetch}>
      <View style={styles.bridgeNote}><RadioTower color={colors.amber} size={19} /><View style={styles.bridgeCopy}><Text style={styles.bridgeTitle}>Local when you are at the venue</Text><Text style={styles.bridgeText}>Remote control uses the venue Bridge. Device credentials stay on the trusted network and are never sent to this screen.</Text></View></View>
      {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
      {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
      <View style={styles.list}>{query.data?.devices.map((device) => {
        const controllable = device.enabled && device.controls.length > 0;
        return <Pressable accessibilityRole={controllable ? "button" : undefined} accessibilityLabel={controllable ? `Control ${device.name}` : undefined} disabled={!controllable} key={device.id} onPress={() => router.push({ pathname: "/device/[deviceId]", params: { deviceId: device.id } })} style={({ pressed }) => [styles.card, pressed && styles.pressed]}><View style={styles.icon}><Cable color={device.enabled ? colors.amber : colors.textFaint} size={20} /></View><View style={styles.copy}><Text style={styles.name}>{device.name}</Text><Text style={styles.meta}>{device.category} · {device.adapterType || "native adapter"}</Text><Text style={styles.controlMeta}>{controllable ? `${device.controls.length} live controls` : "Monitor only"}</Text></View><View style={[styles.state, device.enabled && styles.stateEnabled]}><CirclePower size={11} color={device.enabled ? colors.green : colors.textFaint} /><Text style={[styles.stateText, device.enabled && styles.stateTextEnabled]}>{device.enabled ? "ENABLED" : "OFF"}</Text>{controllable ? <ChevronRight color={colors.textFaint} size={17} /> : null}</View></Pressable>;
      })}</View>
      {query.data && query.data.devices.length === 0 ? <Text style={styles.empty}>No devices are configured for this workspace.</Text> : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  bridgeNote: { flexDirection: "row", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, padding: spacing.medium },
  bridgeCopy: { flex: 1, gap: 5 },
  bridgeTitle: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  bridgeText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  list: { gap: 10 },
  card: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  icon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.panelStrong },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  name: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  meta: { color: colors.textMuted, fontFamily, fontSize: 11, textTransform: "capitalize" },
  state: { flexDirection: "row", alignItems: "center", gap: 4 },
  stateEnabled: {},
  stateText: { color: colors.textFaint, fontFamily, fontSize: 8, fontWeight: "900" },
  stateTextEnabled: { color: colors.green },
  controlMeta: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "800", textTransform: "uppercase" },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center" },
}));
