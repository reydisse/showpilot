import { useEffect, useState, type ReactNode } from "react";
import {
  parseBooleanArrayFeedback,
  parseNumberArrayFeedback,
  parseStringArrayFeedback,
  resolveDeviceControlSurface,
} from "@showpilot/shared";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Activity from "lucide-react-native/icons/activity";
import Lightbulb from "lucide-react-native/icons/lightbulb";
import MonitorUp from "lucide-react-native/icons/monitor-up";
import Radio from "lucide-react-native/icons/radio";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import Video from "lucide-react-native/icons/video";
import type { MobileDeviceAction, MobileDeviceControlState } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type ActionValues = Record<string, number | boolean | string>;
type Feedback = MobileDeviceControlState["feedbacks"][number];

interface DeviceCockpitProps {
  actions: MobileDeviceAction[];
  busy: boolean;
  category: string;
  connected: boolean;
  feedbacks: Feedback[];
  onExecute: (action: MobileDeviceAction, params: ActionValues) => void;
  renderAdvancedAction: (action: MobileDeviceAction) => ReactNode;
}

function byId(actions: MobileDeviceAction[], id: string) {
  return actions.find((action) => action.id === id);
}

function feedbackValue(feedbacks: Feedback[], id: string): unknown {
  return feedbacks.find((feedback) => feedback.id === id && feedback.available)?.value;
}

function sendWithGuard(
  action: MobileDeviceAction,
  params: ActionValues,
  guarded: boolean,
  onExecute: DeviceCockpitProps["onExecute"],
) {
  if (!guarded) {
    onExecute(action, params);
    return;
  }
  Alert.alert(
    `Send “${action.label}”?`,
    "This changes live venue equipment immediately.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Send now", style: "destructive", onPress: () => onExecute(action, params) },
    ],
  );
}

function CockpitButton({
  action,
  busy,
  connected,
  guarded = false,
  label,
  onExecute,
  params = {},
  tone = "default",
}: {
  action: MobileDeviceAction | undefined;
  busy: boolean;
  connected: boolean;
  guarded?: boolean;
  label?: string;
  onExecute: DeviceCockpitProps["onExecute"];
  params?: ActionValues;
  tone?: "default" | "amber" | "green" | "red";
}) {
  const styles = useStyles();
  if (!action) return null;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!connected || busy}
      onPress={() => sendWithGuard(action, params, guarded, onExecute)}
      style={({ pressed }) => [
        styles.command,
        tone === "amber" && styles.commandAmber,
        tone === "green" && styles.commandGreen,
        tone === "red" && styles.commandRed,
        (!connected || busy) && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.commandText, tone === "amber" && styles.commandTextAmber, tone === "green" && styles.commandTextGreen, tone === "red" && styles.commandTextRed]}>
        {busy ? "SENDING…" : label ?? action.label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

function SurfaceHeader({ detail, icon: Icon, title }: { detail: string; icon: React.ElementType; title: string }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={styles.surfaceHeader}>
      <View style={styles.surfaceIcon}><Icon color={colors.amber} size={19} /></View>
      <View style={styles.surfaceCopy}><Text style={styles.surfaceTitle}>{title}</Text><Text style={styles.surfaceDetail}>{detail}</Text></View>
    </View>
  );
}

function AdvancedControls({ actions, renderAction }: { actions: MobileDeviceAction[]; renderAction: DeviceCockpitProps["renderAdvancedAction"] }) {
  const styles = useStyles();
  if (!actions.length) return null;
  return (
    <View style={styles.advanced}>
      <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>ADVANCED CONTROLS</Text><Text style={styles.count}>{actions.length}</Text></View>
      <View style={styles.advancedList}>{actions.map((action) => <View key={action.id}>{renderAction(action)}</View>)}</View>
    </View>
  );
}

function SwitcherSurface(props: DeviceCockpitProps) {
  const styles = useStyles();
  const program = Number(feedbackValue(props.feedbacks, "program_input") ?? feedbackValue(props.feedbacks, "active_input") ?? 0);
  const preview = Number(feedbackValue(props.feedbacks, "preview_input") ?? 0);
  const programAction = byId(props.actions, "set_program_input");
  const previewAction = byId(props.actions, "set_preview_input");
  const maximum = Math.min(20, Number(programAction?.params.find((param) => param.id === "input")?.max ?? 8));
  const inputs = Array.from({ length: maximum }, (_, index) => index + 1);
  const handled = new Set(["set_program_input", "set_preview_input", "cut", "auto_transition", "fade_to_black"]);
  return (
    <View style={styles.surface}>
      <SurfaceHeader icon={Video} title="Switcher" detail="Program, preview and transitions" />
      <View style={styles.surfaceBody}>
        <Text style={styles.programLabel}>PROGRAM</Text>
        <View style={styles.sourceGrid}>{inputs.map((input) => <CockpitButton action={programAction} busy={props.busy} connected={props.connected} key={`program-${input}`} label={String(input)} onExecute={props.onExecute} params={{ input: programAction?.params.find((param) => param.id === "input")?.type === "string" ? String(input) : input }} tone={program === input ? "red" : "default"} />)}</View>
        <Text style={styles.previewLabel}>PREVIEW</Text>
        <View style={styles.sourceGrid}>{inputs.map((input) => <CockpitButton action={previewAction} busy={props.busy} connected={props.connected} key={`preview-${input}`} label={String(input)} onExecute={props.onExecute} params={{ input: previewAction?.params.find((param) => param.id === "input")?.type === "string" ? String(input) : input }} tone={preview === input ? "green" : "default"} />)}</View>
        <View style={styles.primaryRow}>
          <CockpitButton action={byId(props.actions, "cut")} busy={props.busy} connected={props.connected} label="CUT" onExecute={props.onExecute} />
          <CockpitButton action={byId(props.actions, "auto_transition")} busy={props.busy} connected={props.connected} label="AUTO" onExecute={props.onExecute} tone="amber" />
          <CockpitButton action={byId(props.actions, "fade_to_black")} busy={props.busy} connected={props.connected} guarded label="FTB" onExecute={props.onExecute} tone="red" />
        </View>
      </View>
      <AdvancedControls actions={props.actions.filter((action) => !handled.has(action.id))} renderAction={props.renderAdvancedAction} />
    </View>
  );
}

function MixerChannel({
  action,
  busy,
  channel,
  connected,
  level,
  muteAction,
  muted,
  onExecute,
}: {
  action: MobileDeviceAction | undefined;
  busy: boolean;
  channel: number;
  connected: boolean;
  level: number | null;
  muteAction: MobileDeviceAction | undefined;
  muted: boolean | null;
  onExecute: DeviceCockpitProps["onExecute"];
}) {
  const styles = useStyles();
  const [localLevel, setLocalLevel] = useState(level ?? 0);
  const [trackWidth, setTrackWidth] = useState(1);
  useEffect(() => { if (level !== null) setLocalLevel(level); }, [level]);
  const updateLevel = (next: number) => {
    if (!action || !connected || busy) return;
    const normalized = Math.max(0, Math.min(1, next));
    setLocalLevel(normalized);
    onExecute(action, { channel, level: normalized });
  };
  return (
    <View style={styles.channel}>
      <Text style={styles.channelName}>CH {channel}</Text>
      <Text style={styles.channelValue}>{level === null ? "WAIT" : `${Math.round(localLevel * 100)}%`}</Text>
      <Pressable
        accessibilityLabel={`Channel ${channel} fader`}
        accessibilityRole="adjustable"
        disabled={!connected || busy || !action}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        onPress={(event) => updateLevel(event.nativeEvent.locationX / trackWidth)}
        style={styles.faderTrack}
      >
        <View style={[styles.faderFill, { width: `${Math.round(localLevel * 100)}%` }]} />
      </Pressable>
      <View style={styles.stepRow}>
        <Pressable accessibilityLabel={`Lower channel ${channel}`} disabled={!connected || busy} onPress={() => updateLevel(localLevel - 0.05)} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable>
        <Pressable accessibilityLabel={`Raise channel ${channel}`} disabled={!connected || busy} onPress={() => updateLevel(localLevel + 0.05)} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable>
      </View>
      <CockpitButton action={muteAction} busy={busy} connected={connected} label={muted ? "UNMUTE" : "MUTE"} onExecute={onExecute} params={{ channel, muted: !(muted ?? false) }} tone={muted ? "red" : "default"} />
    </View>
  );
}

function MixerSurface(props: DeviceCockpitProps) {
  const styles = useStyles();
  const faders = parseNumberArrayFeedback(feedbackValue(props.feedbacks, "channel_fader"));
  const mutes = parseBooleanArrayFeedback(feedbackValue(props.feedbacks, "channel_mute"));
  const faderAction = byId(props.actions, "set_channel_fader");
  const muteAction = byId(props.actions, "mute_channel");
  const channelCount = Math.min(40, Number(faderAction?.params.find((param) => param.id === "channel")?.max ?? 16));
  const handled = new Set(["set_channel_fader", "mute_channel"]);
  return (
    <View style={styles.surface}>
      <SurfaceHeader icon={SlidersHorizontal} title="Audio mixer" detail="Console fader state and channel mute" />
      <View style={styles.mixerTabs}><Text style={styles.activeTab}>MAIN</Text><Text style={styles.tab}>ALL {channelCount} CHANNELS</Text></View>
      <ScrollView horizontal contentContainerStyle={styles.channelList} showsHorizontalScrollIndicator={false}>
        {Array.from({ length: channelCount }, (_, index) => index + 1).map((channel) => (
          <MixerChannel action={faderAction} busy={props.busy} channel={channel} connected={props.connected} key={channel} level={faders[channel - 1] ?? null} muteAction={muteAction} muted={mutes[channel - 1] ?? null} onExecute={props.onExecute} />
        ))}
      </ScrollView>
      <AdvancedControls actions={props.actions.filter((action) => !handled.has(action.id))} renderAction={props.renderAdvancedAction} />
    </View>
  );
}

function DisplaySurface(props: DeviceCockpitProps) {
  const styles = useStyles();
  const powerFeedback = feedbackValue(props.feedbacks, "power_status");
  const power = powerFeedback === true ? "ON" : powerFeedback === false ? "OFF" : String(powerFeedback ?? "unknown").toUpperCase();
  const input = String(feedbackValue(props.feedbacks, "current_input") ?? "Waiting for display");
  const handled = new Set(["power_on", "power_off", "shutter_close", "shutter_open", "mute_video", "mute", "unmute"]);
  return (
    <View style={styles.surface}>
      <SurfaceHeader icon={MonitorUp} title="Display control" detail="Power, source, blanking and audio" />
      <View style={styles.statusGrid}>
        <View style={styles.statusCard}><Text style={styles.statusLabel}>POWER</Text><Text style={styles.statusValue}>{power}</Text></View>
        <View style={styles.statusCard}><Text style={styles.statusLabel}>INPUT</Text><Text numberOfLines={1} style={styles.statusValue}>{input}</Text></View>
      </View>
      <View style={styles.quickGrid}>
        <CockpitButton action={byId(props.actions, "power_on")} busy={props.busy} connected={props.connected} label="POWER ON" onExecute={props.onExecute} tone="green" />
        <CockpitButton action={byId(props.actions, "power_off")} busy={props.busy} connected={props.connected} guarded label="POWER OFF" onExecute={props.onExecute} tone="red" />
        <CockpitButton action={byId(props.actions, "shutter_close") ?? byId(props.actions, "mute_video")} busy={props.busy} connected={props.connected} guarded label="BLANK" onExecute={props.onExecute} params={{ state: true }} tone="red" />
        <CockpitButton action={byId(props.actions, "shutter_open")} busy={props.busy} connected={props.connected} label="UNBLANK" onExecute={props.onExecute} />
        <CockpitButton action={byId(props.actions, "mute")} busy={props.busy} connected={props.connected} label="MUTE" onExecute={props.onExecute} />
        <CockpitButton action={byId(props.actions, "unmute")} busy={props.busy} connected={props.connected} label="UNMUTE" onExecute={props.onExecute} />
      </View>
      <AdvancedControls actions={props.actions.filter((action) => !handled.has(action.id))} renderAction={props.renderAdvancedAction} />
    </View>
  );
}

function StreamingSurface(props: DeviceCockpitProps) {
  const styles = useStyles();
  const live = feedbackValue(props.feedbacks, "streaming_active") === true;
  const recording = feedbackValue(props.feedbacks, "recording_active") === true;
  const scenes = parseStringArrayFeedback(feedbackValue(props.feedbacks, "scene_list"));
  const sceneAction = byId(props.actions, "set_current_program_scene");
  const handled = new Set(["start_streaming", "stop_streaming", "start_recording", "stop_recording", "set_current_program_scene"]);
  return (
    <View style={styles.surface}>
      <SurfaceHeader icon={Radio} title="Streaming & recording" detail="Live output, recording and scene control" />
      <View style={styles.statusGrid}><View style={styles.statusCard}><Text style={styles.statusLabel}>STREAM</Text><Text style={[styles.statusValue, live && styles.liveValue]}>{live ? "LIVE" : "STOPPED"}</Text></View><View style={styles.statusCard}><Text style={styles.statusLabel}>RECORD</Text><Text style={[styles.statusValue, recording && styles.liveValue]}>{recording ? "RECORDING" : "STOPPED"}</Text></View></View>
      {scenes.length ? <ScrollView horizontal contentContainerStyle={styles.sceneList} showsHorizontalScrollIndicator={false}>{scenes.map((scene) => <CockpitButton action={sceneAction} busy={props.busy} connected={props.connected} key={scene} label={scene} onExecute={props.onExecute} params={{ sceneName: scene }} />)}</ScrollView> : null}
      <View style={styles.quickGrid}>
        <CockpitButton action={byId(props.actions, "start_streaming")} busy={props.busy} connected={props.connected} label="START STREAM" onExecute={props.onExecute} tone="green" />
        <CockpitButton action={byId(props.actions, "stop_streaming")} busy={props.busy} connected={props.connected} guarded label="STOP STREAM" onExecute={props.onExecute} tone="red" />
        <CockpitButton action={byId(props.actions, "start_recording")} busy={props.busy} connected={props.connected} label="START RECORD" onExecute={props.onExecute} />
        <CockpitButton action={byId(props.actions, "stop_recording")} busy={props.busy} connected={props.connected} guarded label="STOP RECORD" onExecute={props.onExecute} tone="red" />
      </View>
      <AdvancedControls actions={props.actions.filter((action) => !handled.has(action.id))} renderAction={props.renderAdvancedAction} />
    </View>
  );
}

function LightingSurface(props: DeviceCockpitProps) {
  const styles = useStyles();
  const blackout = feedbackValue(props.feedbacks, "blackout_active") === true;
  const handled = new Set(["blackout", "restore"]);
  return (
    <View style={styles.surface}>
      <SurfaceHeader icon={Lightbulb} title="Lighting" detail="Master output, scenes and blackout" />
      <View style={[styles.blackoutCard, blackout && styles.blackoutActive]}><Text style={styles.statusLabel}>OUTPUT STATE</Text><Text style={[styles.statusValue, blackout && styles.liveValue]}>{blackout ? "BLACKOUT ACTIVE" : "OUTPUT LIVE"}</Text></View>
      <View style={styles.primaryRow}><CockpitButton action={byId(props.actions, "blackout")} busy={props.busy} connected={props.connected} guarded label="BLACKOUT" onExecute={props.onExecute} tone="red" /><CockpitButton action={byId(props.actions, "restore")} busy={props.busy} connected={props.connected} label="RESTORE" onExecute={props.onExecute} tone="green" /></View>
      <AdvancedControls actions={props.actions.filter((action) => !handled.has(action.id))} renderAction={props.renderAdvancedAction} />
    </View>
  );
}

export function DeviceCockpit(props: DeviceCockpitProps) {
  const styles = useStyles();
  const surface = resolveDeviceControlSurface(props.actions, props.category);
  if (surface === "switcher") return <SwitcherSurface {...props} />;
  if (surface === "mixer") return <MixerSurface {...props} />;
  if (surface === "display") return <DisplaySurface {...props} />;
  if (surface === "streaming") return <StreamingSurface {...props} />;
  if (surface === "lighting") return <LightingSurface {...props} />;
  return (
    <View style={styles.surface}>
      <SurfaceHeader icon={Activity} title={surface === "automation" ? "Automation" : "Device controls"} detail="Actions exposed by this device" />
      <AdvancedControls actions={props.actions} renderAction={props.renderAdvancedAction} />
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  surface: { overflow: "hidden", borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised },
  surfaceHeader: { flexDirection: "row", alignItems: "center", gap: 11, borderBottomWidth: 1, borderBottomColor: colors.borderSoft, padding: spacing.medium },
  surfaceIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  surfaceCopy: { flex: 1, gap: 3 },
  surfaceTitle: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "900" },
  surfaceDetail: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16 },
  surfaceBody: { gap: 10, padding: spacing.medium },
  programLabel: { color: colors.red, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.1 },
  previewLabel: { color: colors.green, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.1, marginTop: 4 },
  sourceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  primaryRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: spacing.medium },
  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, padding: spacing.medium },
  command: { minWidth: 58, minHeight: 44, flexGrow: 1, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 10, paddingVertical: 9 },
  commandAmber: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  commandGreen: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  commandRed: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  commandText: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "900", textAlign: "center" },
  commandTextAmber: { color: colors.amberText },
  commandTextGreen: { color: colors.green },
  commandTextRed: { color: colors.red },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.68 },
  mixerTabs: { flexDirection: "row", alignItems: "center", gap: 15, borderBottomWidth: 1, borderBottomColor: colors.borderSoft, paddingHorizontal: spacing.medium, paddingVertical: 10 },
  activeTab: { overflow: "hidden", borderRadius: radii.small, backgroundColor: colors.amberSoft, color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", paddingHorizontal: 10, paddingVertical: 6 },
  tab: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900" },
  channelList: { gap: 8, padding: spacing.medium },
  channel: { width: 112, gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 10 },
  channelName: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "900" },
  channelValue: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "800" },
  faderTrack: { height: 16, overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.panelStrong },
  faderFill: { height: "100%", borderRadius: radii.pill, backgroundColor: colors.green },
  stepRow: { flexDirection: "row", gap: 6 },
  stepButton: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong },
  stepText: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "800" },
  statusGrid: { flexDirection: "row", gap: 8, padding: spacing.medium },
  statusCard: { flex: 1, minWidth: 0, gap: 6, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 12 },
  statusLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  statusValue: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "900" },
  liveValue: { color: colors.red },
  sceneList: { gap: 7, paddingHorizontal: spacing.medium, paddingBottom: spacing.medium },
  blackoutCard: { gap: 6, margin: spacing.medium, marginBottom: 0, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.greenBorder, backgroundColor: colors.greenSoft, padding: 14 },
  blackoutActive: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  advanced: { gap: 10, borderTopWidth: 1, borderTopColor: colors.borderSoft, padding: spacing.medium },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.1 },
  count: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.panelStrong, color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", paddingHorizontal: 7, paddingVertical: 2 },
  advancedList: { gap: 10 },
}));
