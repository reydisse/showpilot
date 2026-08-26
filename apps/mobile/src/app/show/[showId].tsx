import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import * as Haptics from "@/lib/haptics";
import CircleStop from "lucide-react-native/icons/circle-stop";
import Clock3 from "lucide-react-native/icons/clock-3";
import Minus from "lucide-react-native/icons/minus";
import Pause from "lucide-react-native/icons/pause";
import Play from "lucide-react-native/icons/play";
import Plus from "lucide-react-native/icons/plus";
import RotateCcw from "lucide-react-native/icons/rotate-ccw";
import SkipBack from "lucide-react-native/icons/skip-back";
import SkipForward from "lucide-react-native/icons/skip-forward";
import Wifi from "lucide-react-native/icons/wifi";
import WifiOff from "lucide-react-native/icons/wifi-off";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { useRundownRelay } from "@/hooks/use-rundown-relay";
import { authClient } from "@/lib/auth-client";
import { getMobileRundown, type MobileRundown, type RundownItem } from "@/lib/mobile-api";
import { formatTimer, timerElapsed } from "@/lib/rundown-state";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

function titleFor(show: MobileRundown["show"]) {
  return show.name.trim() || "Untitled show";
}

function RundownContent({ detail, orgId }: { detail: MobileRundown; orgId: string }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const relay = useRundownRelay(orgId, detail.show.serviceDate, detail.show.id);
  const seededRef = useRef(false);
  const sameRoom = relay.showId === detail.show.id && relay.serviceDate === detail.show.serviceDate;
  // Once the relay identifies this room, its empty list is authoritative.
  // Falling back to the HTTP snapshot would resurrect items deleted elsewhere.
  const items = relay.hydrated && sameRoom ? relay.items : detail.items;
  const timer = relay.hydrated && sameRoom ? relay.timer : detail.timer;
  const currentItem = items.find((item) => item.id === timer.currentItemId) ?? null;
  const [elapsed, setElapsed] = useState(() => timerElapsed(timer));
  const controlsEnabled = detail.canControl && relay.status === "connected" && relay.hydrated && sameRoom;

  useEffect(() => {
    if (!relay.hydrated || seededRef.current) return;
    if (sameRoom && relay.items.length === 0 && detail.items.length > 0 && detail.canControl) {
      seededRef.current = true;
      relay.seedState(detail.items, detail.timer);
    } else if (sameRoom && (relay.items.length > 0 || !detail.canControl)) {
      seededRef.current = true;
    }
  }, [detail, relay, sameRoom]);

  useEffect(() => {
    const tick = () => setElapsed(timerElapsed(timer));
    tick();
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [timer]);

  const timerValue = timer.mode === "clock"
    ? new Date(elapsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : currentItem && timer.mode === "count-down"
      ? formatTimer(currentItem.duration - elapsed)
      : formatTimer(elapsed);
  const overtime = Boolean(currentItem && timer.mode === "count-down" && currentItem.duration - elapsed < 0);

  async function command(action: string, payload?: Record<string, unknown>) {
    if (!controlsEnabled) return;
    await Haptics.selectionAsync();
    relay.sendCommand(action, payload);
  }

  function startItem(item: RundownItem) {
    if (item.type === "header" || !controlsEnabled) return;
    void command("timer-start", { itemId: item.id });
  }

  const connectionText = relay.status === "connected"
    ? "Live sync"
    : relay.status === "offline"
      ? "Paused in background"
      : "Reconnecting";

  return (
    <Page eyebrow={detail.show.serviceDate} title={titleFor(detail.show)}>
      <Stack.Screen options={{ title: titleFor(detail.show) }} />
      <View style={styles.connectionRow}>
        {relay.status === "connected" ? <Wifi size={15} color={colors.green} /> : <WifiOff size={15} color={colors.amberText} />}
        <Text style={[styles.connectionText, relay.status === "connected" && styles.connected]}>{connectionText}</Text>
        <View style={styles.permissionBadge}>
          <Text style={styles.permissionText}>{detail.canControl ? "OPERATOR" : "VIEW ONLY"}</Text>
        </View>
      </View>

      <View style={[styles.timerCard, overtime && styles.timerCardOvertime]}>
        <View style={styles.nowRow}>
          <View style={[styles.liveDot, timer.playback !== "play" && styles.liveDotIdle]} />
          <Text style={styles.nowLabel}>{timer.playback === "play" ? "NOW LIVE" : timer.playback === "pause" ? "PAUSED" : "STANDBY"}</Text>
        </View>
        <Text numberOfLines={2} style={styles.currentTitle}>{currentItem?.title ?? "Select an item to begin"}</Text>
        <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.timer, overtime && styles.timerOvertime]}>{timerValue}</Text>
        <Text style={styles.timerMode}>{timer.mode.replace("-", " ").toUpperCase()}</Text>

        {detail.canControl ? (
          <>
            <View style={styles.transport}>
              <ControlButton label="Previous" disabled={!controlsEnabled || !currentItem} onPress={() => void command("timer-prev")}><SkipBack size={22} color={colors.text} /></ControlButton>
              <ControlButton
                label={timer.playback === "play" ? "Pause" : timer.playback === "pause" ? "Resume" : "Start"}
                primary
                disabled={!controlsEnabled || (!currentItem && items.every((item) => item.type === "header"))}
                onPress={() => {
                  if (timer.playback === "play") void command("timer-pause");
                  else if (timer.playback === "pause") void command("timer-resume");
                  else {
                    const firstItem = items.find((item) => item.type !== "header" && item.status !== "complete");
                    if (firstItem) void command("timer-start", { itemId: firstItem.id });
                  }
                }}
              >
                {timer.playback === "play" ? <Pause size={24} color={colors.black} /> : <Play size={24} color={colors.black} fill={colors.black} />}
              </ControlButton>
              <ControlButton label="Next" disabled={!controlsEnabled || !currentItem} onPress={() => void command("timer-next")}><SkipForward size={22} color={colors.text} /></ControlButton>
            </View>
            <View style={styles.adjustRow}>
              <MiniButton label="−30 sec" disabled={!controlsEnabled || !currentItem} onPress={() => void command("timer-adjust", { deltaMs: -30_000 })}><Minus size={16} color={colors.textMuted} /></MiniButton>
              <MiniButton label="+30 sec" disabled={!controlsEnabled || !currentItem} onPress={() => void command("timer-adjust", { deltaMs: 30_000 })}><Plus size={16} color={colors.textMuted} /></MiniButton>
              <MiniButton label="Stop" disabled={!controlsEnabled || !currentItem} onPress={() => void command("timer-stop")}><CircleStop size={16} color={colors.red} /></MiniButton>
              <MiniButton label="Reset" disabled={!controlsEnabled} onPress={() => void command("reset")}><RotateCcw size={16} color={colors.textMuted} /></MiniButton>
            </View>
          </>
        ) : (
          <Text style={styles.observerCopy}>You can follow every live change. An admin can grant you rundown control when you are on duty.</Text>
        )}
      </View>

      {relay.lastError ? <Text style={styles.syncError}>{relay.lastError}</Text> : null}

      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>RUNDOWN</Text>
        <Text style={styles.sectionCount}>{items.length} ITEMS</Text>
      </View>
      <View style={styles.list}>
        {items.map((item, index) => {
          const active = item.id === timer.currentItemId;
          const header = item.type === "header";
          return (
            <Pressable
              key={item.id}
              accessibilityRole={!header && detail.canControl ? "button" : undefined}
              disabled={header || !detail.canControl}
              onPress={() => startItem(item)}
              style={({ pressed }) => [
                header ? styles.itemHeader : styles.item,
                active && styles.itemActive,
                pressed && styles.itemPressed,
              ]}
            >
              {header ? (
                <Text style={styles.headerTitle}>{item.title}</Text>
              ) : (
                <>
                  <View style={[styles.itemIndex, active && styles.itemIndexActive]}><Text style={[styles.itemIndexText, active && styles.itemIndexTextActive]}>{index + 1}</Text></View>
                  <View style={styles.itemCopy}>
                    <Text numberOfLines={2} style={[styles.itemTitle, active && styles.itemTitleActive]}>{item.title}</Text>
                    <Text style={styles.itemMeta}>{formatTimer(item.duration)}{item.assignee ? `  ·  ${item.assignee}` : ""}</Text>
                  </View>
                  {active ? <View style={styles.activeBars}><View style={styles.bar} /><View style={styles.barTall} /><View style={styles.bar} /></View> : item.hardStop ? <Clock3 size={16} color={colors.red} /> : null}
                </>
              )}
            </Pressable>
          );
        })}
      </View>
      {items.length === 0 ? <Text style={styles.empty}>This show has no rundown items yet.</Text> : null}
    </Page>
  );
}

function ControlButton({ children, label, primary, disabled, onPress }: { children: React.ReactNode; label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.control, primary && styles.controlPrimary, disabled && styles.disabled, pressed && styles.pressed]}>
      {children}
      <Text style={[styles.controlLabel, primary && styles.controlLabelPrimary]}>{label}</Text>
    </Pressable>
  );
}

function MiniButton({ children, label, disabled, onPress }: { children: React.ReactNode; label: string; disabled?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.miniButton, disabled && styles.disabled, pressed && styles.pressed]}>
      {children}<Text style={styles.miniLabel}>{label}</Text>
    </Pressable>
  );
}

export default function ShowDetailScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { showId } = useLocalSearchParams<{ showId: string }>();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const query = useQuery({
    queryKey: ["mobile-rundown", organization?.id, showId],
    queryFn: () => getMobileRundown(organization!.id, showId),
    enabled: Boolean(organization?.id && showId),
  });

  if (sessionPending || organizationPending || query.isPending) {
    return <Page><ActivityIndicator style={styles.loading} color={colors.amber} size="large" /></Page>;
  }
  if (!session) return <Redirect href="/sign-in" />;
  if (!organization) return <Redirect href="/organizations" />;
  if (query.error || !query.data) {
    return (
      <Page eyebrow="RUNDOWN" title="Could not open show">
        <Text style={styles.syncError}>{query.error?.message ?? "The show is unavailable."}</Text>
        <AppButton label="Try again" onPress={() => query.refetch()} />
      </Page>
    );
  }
  return <RundownContent key={query.data.show.id} detail={query.data} orgId={organization.id} />;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  loading: { marginTop: 80 },
  connectionRow: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 8, marginTop: -12 },
  connectionText: { flex: 1, color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "700" },
  connected: { color: colors.green },
  permissionBadge: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingHorizontal: 9, paddingVertical: 5 },
  permissionText: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  timerCard: { alignItems: "center", gap: 10, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.large },
  timerCardOvertime: { borderColor: colors.redStrongBorder, backgroundColor: colors.redSoft },
  nowRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  liveDotIdle: { backgroundColor: colors.textFaint },
  nowLabel: { color: colors.textFaint, fontFamily, fontSize: 10, fontWeight: "900", letterSpacing: 1.8 },
  currentTitle: { minHeight: 24, color: colors.text, fontFamily, fontSize: 18, lineHeight: 24, fontWeight: "700", textAlign: "center" },
  timer: { width: "100%", color: colors.amberText, fontFamily: "monospace", fontSize: 66, lineHeight: 74, fontWeight: "800", letterSpacing: -4, textAlign: "center" },
  timerOvertime: { color: colors.red },
  timerMode: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "800", letterSpacing: 1.5 },
  transport: { width: "100%", flexDirection: "row", gap: 10, marginTop: 10 },
  control: { flex: 1, minHeight: 67, alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong },
  controlPrimary: { backgroundColor: colors.amber, borderColor: colors.amber },
  controlLabel: { color: colors.text, fontFamily, fontSize: 10, fontWeight: "700" },
  controlLabelPrimary: { color: colors.black },
  adjustRow: { width: "100%", flexDirection: "row", gap: 8 },
  miniButton: { flex: 1, minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  miniLabel: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "700" },
  observerCopy: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center", marginTop: 8 },
  syncError: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 19 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textFaint, fontFamily, fontSize: 10, fontWeight: "900", letterSpacing: 1.6 },
  sectionCount: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "700", letterSpacing: 1 },
  list: { gap: 8 },
  item: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 12 },
  itemActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  itemPressed: { opacity: 0.72 },
  itemHeader: { marginTop: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTitle: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.3, textTransform: "uppercase" },
  itemIndex: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: colors.panelStrong },
  itemIndexActive: { backgroundColor: colors.amber },
  itemIndexText: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800" },
  itemIndexTextActive: { color: colors.black },
  itemCopy: { flex: 1, minWidth: 0, gap: 5 },
  itemTitle: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 19, fontWeight: "700" },
  itemTitleActive: { color: colors.amberText },
  itemMeta: { color: colors.textFaint, fontFamily, fontSize: 11 },
  activeBars: { width: 18, height: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2 },
  bar: { width: 2, height: 8, borderRadius: 1, backgroundColor: colors.green },
  barTall: { width: 2, height: 15, borderRadius: 1, backgroundColor: colors.green },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
}));
