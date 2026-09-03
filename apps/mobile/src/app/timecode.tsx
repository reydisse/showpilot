import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useTimecodeRelay } from "@/hooks/use-timecode-relay";
import { commandMobileTimecode, getMobileTimecode } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily } from "@/theme/tokens";

const parseTimecode = (value: string) => {
  const match = /^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [hours, minutes, seconds, frames] = match.slice(1).map(Number);
  return hours <= 23 && minutes <= 59 && seconds <= 59 ? { hours, minutes, seconds, frames } : null;
};

const automationActions = [
  ["rundown-advance", "Next item"], ["rundown-previous", "Previous item"],
  ["rundown-start-item", "Start item"], ["rundown-pause", "Pause timer"],
  ["rundown-resume", "Resume timer"], ["rundown-stop", "Stop rundown"],
  ["rundown-adjust", "Adjust timer"], ["stage-message", "Stage message"],
  ["stage-clear", "Clear stage"], ["lower-third-show", "Show lower third"],
  ["lower-third-clear", "Clear lower third"], ["device-action", "Device action"],
  ["lighting-scene", "Lighting scene"], ["custom-webhook", "Webhook"],
] as const;

export default function TimecodeScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const query = useQuery({
    queryKey: ["mobile-timecode", orgId],
    queryFn: () => getMobileTimecode(orgId!),
    enabled: Boolean(orgId),
    refetchInterval: 30_000,
  });
  const [timecode, setTimecode] = useState("00:00:00:00");
  const [eventLabel, setEventLabel] = useState("");
  const [eventTimecode, setEventTimecode] = useState("00:00:10:00");
  const [eventAction, setEventAction] = useState<(typeof automationActions)[number][0]>("rundown-advance");
  const [eventPayload, setEventPayload] = useState("{}");
  const [error, setError] = useState("");
  const relay = useTimecodeRelay(orgId, query.data);
  const command = useMutation({
    mutationFn: commandMobileTimecode,
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["mobile-timecode", orgId] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Timecode command failed."),
  });
  const data = relay.state ? { state: relay.state, events: relay.events } : query.data;

  if (!orgId || query.isPending) return <LoadingView label="Opening timecode…" />;

  const run = (action: Parameters<typeof commandMobileTimecode>[0]["action"], payload?: Record<string, unknown>) => {
    command.mutate({ orgId, action, payload });
  };
  const setManualTimecode = () => {
    const parsed = parseTimecode(timecode);
    if (!parsed || (data && parsed.frames >= Math.round(data.state.format.frameRate))) {
      setError("Enter a valid SMPTE timecode for the selected frame rate.");
      return;
    }
    run("set-timecode", { timecode: parsed });
  };
  const addEvent = () => {
    const parsed = parseTimecode(eventTimecode);
    if (!parsed || !eventLabel.trim()) {
      setError("An event label and valid SMPTE timecode are required.");
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(eventPayload) as Record<string, unknown>;
    } catch {
      setError("Action details must be valid JSON.");
      return;
    }
    run("add-event", {
      id: `native-${Date.now()}`,
      label: eventLabel.trim(),
      triggerTimecode: parsed,
      triggerFrame: 0,
      action: eventAction,
      payload,
      fired: false,
      toleranceFrames: 2,
    });
    setEventLabel("");
  };

  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="SMPTE RELAY" title="Timecode" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.error ? <OperationsError message={query.error.message} /> : null}
      {error ? <OperationsError message={error} /> : null}
      {relay.lastError ? <OperationsError message={relay.lastError} /> : null}
      <View style={styles.clockCard}>
        <Text accessibilityLabel={`Timecode ${data?.state.display ?? "unavailable"}`} style={styles.clock}>{data?.state.display ?? "--:--:--:--"}</Text>
        <Text style={styles.clockMeta}>{data?.state.source.replaceAll("-", " ")} · {data?.state.format.frameRate} fps {data?.state.format.dropFrame.toUpperCase()} · {data?.state.running ? "running" : "stopped"} · {relay.status}{relay.isMaster ? " · this device is master" : ""}</Text>
      </View>
      <OperationsPanel title="Transport" detail="Control the shared relay used by web, desktop, overlays, and automation.">
        <View style={styles.buttonRow}>
          <View style={styles.button}><AppButton label="Start freerun" loading={relay.starting} disabled={relay.status !== "connected" || relay.isMaster} onPress={relay.startFreerun} /></View>
          <View style={styles.button}><AppButton label="Stop" variant="secondary" disabled={relay.status !== "connected"} onPress={relay.stopFreerun} /></View>
        </View>
        <AppField label="Set timecode" value={timecode} onChangeText={setTimecode} autoCapitalize="characters" placeholder="00:00:00:00" />
        <AppButton label="Set relay time" variant="secondary" disabled={command.isPending || data?.state.running} onPress={setManualTimecode} />
      </OperationsPanel>
      <OperationsPanel title="Source and format" detail="This device can generate internal freerun. MTC, LTC, rundown, and network sources remain visible here when supplied by the desktop or bridge.">
        <View style={styles.buttonRow}>
          {[24, 25, 29.97, 30].map((frameRate) => (
            <View key={frameRate} style={styles.button}><AppButton label={`${frameRate}`} disabled={data?.state.running} variant={data?.state.format.frameRate === frameRate ? "primary" : "secondary"} onPress={() => run("set-format", { format: { frameRate, dropFrame: frameRate === 29.97 ? "df" : "ndf" } })} /></View>
          ))}
        </View>
      </OperationsPanel>
      <OperationsPanel title="Automation" detail="Create the same shared actions used by web and desktop. Events fire when the relay crosses the selected frame.">
        <AppField label="Event label" value={eventLabel} onChangeText={setEventLabel} placeholder="Advance to sermon" />
        <AppField label="Trigger timecode" value={eventTimecode} onChangeText={setEventTimecode} placeholder="00:00:10:00" />
        <Text style={styles.fieldLabel}>ACTION</Text>
        <View style={styles.actionGrid}>{automationActions.map(([value, label]) => <Pressable accessibilityRole="button" accessibilityState={{ selected: eventAction === value }} key={value} onPress={() => setEventAction(value)} style={[styles.actionChoice, eventAction === value && styles.actionChoiceActive]}><Text style={[styles.actionChoiceText, eventAction === value && styles.actionChoiceTextActive]}>{label}</Text></Pressable>)}</View>
        <AppField label="Action details (JSON)" value={eventPayload} onChangeText={setEventPayload} multiline placeholder={eventAction === "stage-message" ? '{"message":"Stand by"}' : eventAction === "rundown-adjust" ? '{"deltaMs":30000}' : "{}"} />
        <AppButton label="Add automation event" disabled={command.isPending} onPress={addEvent} />
        {data?.events.length ? data.events.map((event) => (
          <OperationsRow key={event.id} title={event.label} detail={`${event.triggerTimecode.hours.toString().padStart(2, "0")}:${event.triggerTimecode.minutes.toString().padStart(2, "0")}:${event.triggerTimecode.seconds.toString().padStart(2, "0")}:${event.triggerTimecode.frames.toString().padStart(2, "0")} · ${event.action}`} status={event.fired ? "Fired" : "Armed"} onPress={() => Alert.alert("Remove automation event?", `Remove “${event.label}” from the shared timecode relay?`, [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => run("remove-event", { id: event.id }) }])} />
        )) : <OperationsEmpty>No automation events are armed.</OperationsEmpty>}
        {data?.events.length ? <AppButton label="Reset fired events" variant="secondary" onPress={() => run("reset-events")} /> : null}
      </OperationsPanel>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  clockCard: { alignItems: "center", gap: 8, borderRadius: 22, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.black, paddingHorizontal: 12, paddingVertical: 28 },
  clock: { color: colors.amberText, fontFamily, fontSize: 39, fontWeight: "900", fontVariant: ["tabular-nums"], letterSpacing: 1 },
  clockMeta: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  fieldLabel: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16, fontWeight: "800", letterSpacing: 1.1 },
  actionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  actionChoice: { minHeight: 40, justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 11 },
  actionChoiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  actionChoiceText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16, fontWeight: "700" },
  actionChoiceTextActive: { color: colors.amberText },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flex: 1, minWidth: 80 },
}));
