import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect, router } from "expo-router";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import ListVideo from "lucide-react-native/icons/list-video";
import MessageSquareText from "lucide-react-native/icons/message-square-text";
import MonitorPlay from "lucide-react-native/icons/monitor-play";
import RadioTower from "lucide-react-native/icons/radio-tower";
import UsersRound from "lucide-react-native/icons/users-round";
import Wifi from "lucide-react-native/icons/wifi";
import WifiOff from "lucide-react-native/icons/wifi-off";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useRundownRelay } from "@/hooks/use-rundown-relay";
import {
  getMobileShowWorkspace,
  type MobileShowWorkspace,
  type RundownItem,
  type RundownTimer,
} from "@/lib/mobile-api";
import { formatTimer, timerElapsed } from "@/lib/rundown-state";
import { formatServiceTime } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type NativeRuntime = Extract<MobileShowWorkspace["runtime"], { kind: "native" }>;
type OntimeRuntime = Extract<MobileShowWorkspace["runtime"], { kind: "ontime" }>;

interface SequenceItem {
  id: string;
  title: string;
  duration: number;
  meta: string;
  active: boolean;
  complete: boolean;
  header: boolean;
}

interface LivePanelState {
  playback: string;
  timerText: string;
  currentTitle: string;
  currentMeta: string;
  nextTitle: string | null;
  overtime: boolean;
  progress: number;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "SP";
}

function formatOntimeClock(value: number, clockFormat: MobileShowWorkspace["clockFormat"]) {
  const totalMinutes = Math.floor(value / 60_000);
  const hours24 = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  if (clockFormat === "24hr") return `${String(hours24).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  return `${hours24 % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function NativeLivePanel({ items, timer }: {
  items: RundownItem[];
  timer: RundownTimer;
}) {
  const [state, setState] = useState<LivePanelState>({
    playback: "stop",
    timerText: "--:--",
    currentTitle: "Waiting for the first cue",
    currentMeta: "The live state is ready",
    nextTitle: null,
    overtime: false,
    progress: 0,
  });
  useEffect(() => {
    const update = () => {
      const elapsed = timerElapsed(timer);
      const currentIndex = items.findIndex((item) => item.id === timer.currentItemId);
      const current = currentIndex >= 0 ? items[currentIndex] : null;
      const next = items.find((item, index) => index > currentIndex && item.type !== "header" && item.status !== "complete") ?? null;
      const remaining = current && timer.mode === "count-down" ? current.duration - elapsed : elapsed;
      setState({
        playback: timer.playback,
        timerText: timer.mode === "clock"
          ? new Date(elapsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
          : current ? formatTimer(remaining) : "--:--",
        currentTitle: current?.title || "Waiting for the first cue",
        currentMeta: current ? `${formatTimer(current.duration)}${current.assignee ? ` · ${current.assignee}` : ""}` : "The live state is ready",
        nextTitle: next?.title ?? null,
        overtime: Boolean(current && timer.mode === "count-down" && remaining < 0),
        progress: current && timer.mode !== "clock" && current.duration > 0
          ? Math.min(100, Math.max(0, elapsed / current.duration * 100))
          : 0,
      });
    };
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [items, timer]);
  return <LivePanel state={state} />;
}

function LivePanel({ state }: { state: LivePanelState }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const playing = state.playback === "play" || state.playback === "roll";
  const paused = state.playback === "pause" || state.playback === "armed";
  const label = playing ? "LIVE" : paused ? state.playback.toUpperCase() : "STANDBY";
  return (
    <View style={[styles.livePanel, state.overtime && styles.livePanelOvertime]}>
      <View style={styles.liveStatusRow}>
        <View style={[styles.liveDot, playing ? styles.liveDotPlaying : paused ? styles.liveDotPaused : null]} />
        <Text style={[styles.liveStatus, playing && styles.liveStatusPlaying]}>{label}</Text>
        {state.overtime ? <Text style={styles.overtime}>OVERTIME</Text> : null}
      </View>
      <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.timer, state.overtime && styles.timerOvertime]}>{state.timerText}</Text>
      <View style={styles.progressTrack}><View style={[styles.progressFill, state.overtime && styles.progressOvertime, { width: `${state.progress}%` }]} /></View>
      <View style={styles.currentCopy}>
        <Text numberOfLines={2} style={styles.currentTitle}>{state.currentTitle}</Text>
        <Text numberOfLines={1} style={styles.currentMeta}>{state.currentMeta}</Text>
        {state.nextTitle ? <Text numberOfLines={1} style={styles.nextTitle}>Next  ·  <Text style={styles.nextName}>{state.nextTitle}</Text></Text> : null}
      </View>
      <View style={styles.liveSource}><RadioTower color={playing ? colors.green : colors.textFaint} size={14} /><Text style={styles.liveSourceText}>{playing ? "Synchronized across operators" : "Following authoritative live state"}</Text></View>
    </View>
  );
}

function QuickActions({ workspace, showId }: { workspace: MobileShowWorkspace; showId: string | null }) {
  const actions = [
    workspace.chatAvailable ? { id: "chat", label: "Chat", icon: MessageSquareText, onPress: () => router.push("/chat") } : null,
    workspace.canOpenRundown && showId ? { id: "rundown", label: "Full rundown", icon: ListVideo, onPress: () => router.push({ pathname: "/show/[showId]", params: { showId } }) } : null,
    workspace.showBoardAvailable ? { id: "board", label: "Show Board", icon: MonitorPlay, onPress: () => router.push("/show-board") } : null,
  ].filter((action) => action !== null);
  const { colors } = useAppTheme();
  const styles = useStyles();
  if (!actions.length) return null;
  return (
    <View style={styles.actionRow}>
      {actions.map((action) => {
        const Icon = action.icon;
        return <Pressable accessibilityRole="button" key={action.id} onPress={action.onPress} style={({ pressed }) => [styles.action, pressed && styles.pressed]}><Icon color={colors.amberText} size={18} /><Text style={styles.actionLabel}>{action.label}</Text><ChevronRight color={colors.textFaint} size={15} /></Pressable>;
      })}
    </View>
  );
}

function CrewStrip({ crew }: { crew: MobileShowWorkspace["crew"] }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const activeCrew = crew.filter((member) => member.isOnline);
  return (
    <View style={styles.crewSection}>
      <View style={styles.sectionRow}><View style={styles.sectionTitleRow}><UsersRound size={16} color={colors.textMuted} /><Text style={styles.sectionTitle}>ACTIVE CREW</Text></View><Text style={styles.sectionCount}>{activeCrew.length} OF {crew.length}</Text></View>
      {activeCrew.length ? <FlatList contentContainerStyle={styles.crewList} data={activeCrew} horizontal keyExtractor={(member) => member.id} renderItem={({ item }) => <View style={styles.crewCard}>{item.photoUrl ? <Image accessibilityLabel={item.name} source={{ uri: item.photoUrl }} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarText}>{initials(item.name)}</Text></View>}<View style={styles.crewCopy}><Text numberOfLines={1} style={styles.crewName}>{item.name}</Text><Text numberOfLines={1} style={styles.crewRole}>{item.role}</Text></View><View style={styles.onlineDot} /></View>} showsHorizontalScrollIndicator={false} /> : <Text style={styles.emptyInline}>No crew members are checked in yet.</Text>}
    </View>
  );
}

function SequenceRow({ item }: { item: SequenceItem }) {
  const styles = useStyles();
  if (item.header) return <View style={styles.sequenceHeader}><Text style={styles.sequenceHeaderText}>{item.title}</Text></View>;
  return (
    <View style={[styles.sequenceItem, item.active && styles.sequenceItemActive, item.complete && styles.sequenceItemComplete]}>
      <View style={[styles.sequenceDot, item.active && styles.sequenceDotActive, item.complete && styles.sequenceDotComplete]} />
      <View style={styles.sequenceCopy}><Text numberOfLines={2} style={[styles.sequenceTitle, item.active && styles.sequenceTitleActive, item.complete && styles.sequenceTitleComplete]}>{item.title}</Text>{item.meta ? <Text numberOfLines={1} style={styles.sequenceMeta}>{item.meta}</Text> : null}</View>
      <Text style={styles.sequenceDuration}>{formatTimer(item.duration)}</Text>
    </View>
  );
}

function WorkspaceList({ workspace, livePanel, items, showId, title, subtitle, onRefresh, refreshing }: {
  workspace: MobileShowWorkspace;
  livePanel: React.ReactNode;
  items: SequenceItem[];
  showId: string | null;
  title: string;
  subtitle: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Page backTo="/(app)/shows" backLabel="Back to shows" eyebrow="LIVE WORKSPACE" title={title} scroll={false}>
      <FlatList
        contentContainerStyle={styles.list}
        data={items}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={<View style={styles.headerContent}><View style={styles.workspaceStatus}>{workspace.adapterStatus === "fallback" ? <WifiOff color={colors.red} size={15} /> : <Wifi color={colors.green} size={15} />}<Text style={[styles.workspaceStatusText, workspace.adapterStatus === "fallback" && styles.workspaceStatusFallback]}>{workspace.adapterStatus === "fallback" ? "OnTime unavailable · Native fallback" : `${workspace.runtime.kind === "ontime" ? "OnTime" : "Native"} live source`}</Text><Text style={styles.workspaceClock}>{subtitle}</Text></View>{livePanel}<QuickActions workspace={workspace} showId={showId} /><CrewStrip crew={workspace.crew} /><View style={styles.sectionRow}><View style={styles.sectionTitleRow}><ListVideo color={colors.textMuted} size={16} /><Text style={styles.sectionTitle}>RUNDOWN</Text></View><Text style={styles.sectionCount}>{items.length} ITEMS</Text></View></View>}
        ListEmptyComponent={<Text style={styles.empty}>No current or upcoming rundown is available. Create a show from the Shows tab when the next service is ready.</Text>}
        onRefresh={onRefresh}
        refreshing={refreshing}
        renderItem={({ item }) => <SequenceRow item={item} />}
        windowSize={7}
      />
    </Page>
  );
}

function NativeWorkspace({ workspace, runtime, orgId, onRefresh, refreshing }: { workspace: MobileShowWorkspace; runtime: NativeRuntime; orgId: string; onRefresh: () => void; refreshing: boolean }) {
  const relay = useRundownRelay(orgId, runtime.show?.serviceDate ?? "", runtime.show?.id ?? "");
  const sameRoom = Boolean(runtime.show && relay.showId === runtime.show.id && relay.serviceDate === runtime.show.serviceDate);
  const authoritative = relay.hydrated && relay.initialized && sameRoom;
  const items = authoritative ? relay.items : runtime.items;
  const timer = authoritative ? relay.timer : runtime.timer;
  const sequence = items.map((item) => ({ id: item.id, title: item.title || "Untitled", duration: item.duration, meta: item.assignee || item.notes, active: item.id === timer.currentItemId, complete: item.status === "complete", header: item.type === "header" }));
  const subtitle = runtime.show ? `${runtime.show.serviceDate} · ${formatServiceTime(runtime.show.scheduledStartTime, workspace.timeZone)}` : "No upcoming service";
  return <WorkspaceList workspace={workspace} livePanel={<NativeLivePanel items={items} timer={timer} />} items={sequence} showId={runtime.show?.id ?? null} title={runtime.show?.name || "Live Show"} subtitle={subtitle} onRefresh={onRefresh} refreshing={refreshing} />;
}

function OntimeWorkspace({ workspace, runtime, onRefresh, refreshing }: { workspace: MobileShowWorkspace; runtime: OntimeRuntime; onRefresh: () => void; refreshing: boolean }) {
  const current = runtime.eventNow;
  const sequence = runtime.events.map((event) => ({ id: event.id, title: event.title || "Untitled", duration: event.duration, meta: event.note || formatOntimeClock(event.timeStart, workspace.clockFormat), active: event.id === current?.id, complete: false, header: false }));
  const duration = runtime.timer.duration ?? 0;
  const elapsed = runtime.timer.elapsed ?? 0;
  const liveState: LivePanelState = {
    playback: runtime.timer.playback,
    timerText: runtime.timer.current === null ? "--:--" : formatTimer(runtime.timer.current),
    currentTitle: current?.title || "Waiting for the first cue",
    currentMeta: current ? `${formatOntimeClock(current.timeStart, workspace.clockFormat)} – ${formatOntimeClock(current.timeEnd, workspace.clockFormat)}` : "OnTime is connected",
    nextTitle: runtime.eventNext?.title ?? null,
    overtime: (runtime.timer.current ?? 0) < 0,
    progress: duration > 0 ? Math.min(100, Math.max(0, elapsed / duration * 100)) : 0,
  };
  const subtitle = runtime.clock ? new Date(runtime.clock).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "OnTime";
  return <WorkspaceList workspace={workspace} livePanel={<LivePanel state={liveState} />} items={sequence} showId={null} title="Live Show" subtitle={subtitle} onRefresh={onRefresh} refreshing={refreshing} />;
}

export default function LiveShowScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const { organization, data: bootstrap, isPending: bootstrapPending } = useMobileBootstrap();
  const canView = bootstrap?.identity.permissions.includes("show:view") === true;
  const query = useQuery({
    queryKey: ["mobile-show-workspace", organization?.id],
    queryFn: () => getMobileShowWorkspace(organization!.id),
    enabled: Boolean(organization?.id && canView),
    refetchInterval: (current) => current.state.data?.runtime.kind === "ontime" ? 1_500 : 5_000,
  });
  if (!organization) return <Redirect href="/organizations" />;
  if (bootstrapPending || (canView && query.isPending)) return <Page backTo="/(app)/shows" backLabel="Back to shows"><ActivityIndicator color={colors.amber} size="large" style={styles.loading} /></Page>;
  if (!canView) return <Redirect href="/(app)/shows" />;
  if (query.error || !query.data) return <Page backTo="/(app)/shows" backLabel="Back to shows" eyebrow="LIVE WORKSPACE" title="Could not open Show"><Text style={styles.error}>{query.error?.message ?? "The live workspace is unavailable."}</Text><AppButton label="Try again" onPress={() => void query.refetch()} /></Page>;
  const refresh = async () => {
    setManualRefreshing(true);
    try {
      await query.refetch();
    } finally {
      setManualRefreshing(false);
    }
  };
  return query.data.runtime.kind === "native"
    ? <NativeWorkspace workspace={query.data} runtime={query.data.runtime} orgId={organization.id} onRefresh={() => void refresh()} refreshing={manualRefreshing} />
    : <OntimeWorkspace workspace={query.data} runtime={query.data.runtime} onRefresh={() => void refresh()} refreshing={manualRefreshing} />;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  loading: { flex: 1 },
  error: { color: colors.red, fontFamily, fontSize: 14, lineHeight: 21 },
  list: { gap: 8, paddingBottom: spacing.large },
  headerContent: { gap: spacing.medium, marginBottom: 8 },
  workspaceStatus: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: 7 },
  workspaceStatusText: { flex: 1, color: colors.green, fontFamily, fontSize: 11, fontWeight: "800" },
  workspaceStatusFallback: { color: colors.red },
  workspaceClock: { color: colors.textMuted, fontFamily, fontSize: 11 },
  livePanel: { gap: 12, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.large },
  livePanelOvertime: { borderColor: colors.redStrongBorder, backgroundColor: colors.redSoft },
  liveStatusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textFaint },
  liveDotPlaying: { backgroundColor: colors.green },
  liveDotPaused: { backgroundColor: colors.amber },
  liveStatus: { flex: 1, color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  liveStatusPlaying: { color: colors.green },
  overtime: { color: colors.red, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  timer: { width: "100%", color: colors.text, fontFamily: "monospace", fontSize: 64, lineHeight: 72, fontWeight: "800", letterSpacing: -3, textAlign: "center" },
  timerOvertime: { color: colors.red },
  progressTrack: { height: 5, overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.border },
  progressFill: { height: "100%", borderRadius: radii.pill, backgroundColor: colors.amber },
  progressOvertime: { backgroundColor: colors.red },
  currentCopy: { gap: 5, borderTopWidth: 1, borderTopColor: colors.borderSoft, paddingTop: 12 },
  currentTitle: { color: colors.text, fontFamily, fontSize: 18, lineHeight: 24, fontWeight: "800" },
  currentMeta: { color: colors.textMuted, fontFamily, fontSize: 12 },
  nextTitle: { color: colors.textFaint, fontFamily, fontSize: 12, marginTop: 3 },
  nextName: { color: colors.textMuted, fontWeight: "700" },
  liveSource: { flexDirection: "row", alignItems: "center", gap: 7 },
  liveSourceText: { color: colors.textFaint, fontFamily, fontSize: 11 },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  action: { minHeight: 44, flexGrow: 1, flexBasis: 130, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, paddingHorizontal: 12 },
  actionLabel: { flex: 1, color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  sectionRow: { minHeight: 30, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  sectionTitle: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.3 },
  sectionCount: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  crewSection: { gap: 10 },
  crewList: { gap: 8 },
  crewCard: { width: 180, minHeight: 58, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 9 },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.panelStrong },
  avatarFallback: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19, backgroundColor: colors.amberSoft },
  avatarText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900" },
  crewCopy: { flex: 1, minWidth: 0, gap: 3 },
  crewName: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  crewRole: { color: colors.textFaint, fontFamily, fontSize: 11 },
  onlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  emptyInline: { color: colors.textFaint, fontFamily, fontSize: 12, lineHeight: 18 },
  sequenceHeader: { minHeight: 48, justifyContent: "flex-end", borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 4, paddingBottom: 9, marginTop: 8 },
  sequenceHeaderText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.3, textTransform: "uppercase" },
  sequenceItem: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 11, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 12 },
  sequenceItemActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  sequenceItemComplete: { opacity: 0.6 },
  sequenceDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textFaint },
  sequenceDotActive: { backgroundColor: colors.amber },
  sequenceDotComplete: { backgroundColor: colors.green },
  sequenceCopy: { flex: 1, minWidth: 0, gap: 4 },
  sequenceTitle: { color: colors.text, fontFamily, fontSize: 13, lineHeight: 18, fontWeight: "700" },
  sequenceTitleActive: { color: colors.amberText },
  sequenceTitleComplete: { textDecorationLine: "line-through" },
  sequenceMeta: { color: colors.textFaint, fontFamily, fontSize: 11 },
  sequenceDuration: { color: colors.textMuted, fontFamily: "monospace", fontSize: 11 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
}));
