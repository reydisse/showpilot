import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/providers/workspace-provider";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useTimecodeRelay } from "@/hooks/use-timecode-relay";
import { commandMobileTimecode, getMobileTimecode, getMobileTimecodeShows } from "@/lib/mobile-api";
import { createLocalRequestUuid } from "@/lib/request-id";
import { timecodeEventStatus, type MobileTimecodeShow } from "@/lib/timecode-contract";
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
  ["lighting-scene", "Lighting scene"], ["lyrics-goto", "Show lyric section"],
  ["lyrics-clear", "Clear lyrics"], ["pp-trigger-slide", "ProPresenter slide"],
  ["pp-trigger-next", "ProPresenter next"], ["pp-trigger-clear", "Clear ProPresenter"],
  ["custom-webhook", "Webhook"],
] as const;

export default function TimecodeScreen() {
  const bootstrap = useMobileBootstrap({ retry: false });
  if (bootstrap.organizationPending || bootstrap.organization && bootstrap.isPending)
    return <LoadingView label="Loading shows…" />;
  if (!bootstrap.organization || !bootstrap.data) return (
    <Page backTo="/(app)/operations" title="Timecode">
      <OperationsError message={bootstrap.error?.message ?? "Choose an organization before opening timecode."} />
      <AppButton label="Retry loading shows" onPress={() => void bootstrap.refetch()} />
    </Page>
  );
  return <TimecodeShows key={`${bootstrap.organization.id}:${bootstrap.data.identity.userId}`} orgId={bootstrap.organization.id} actorId={bootstrap.data.identity.userId} />;
}

function TimecodeShows({ orgId, actorId }: { orgId: string; actorId: string }) {
  const [show, setShow] = useState<MobileTimecodeShow | null>(null);
  const query = useQuery({
    queryKey: ["mobile-timecode-shows", orgId, actorId],
    queryFn: () => getMobileTimecodeShows(orgId),
    retry: false,
  });
  if (show) return <TimecodeShow key={`${show.id}:${show.serviceDate}`} orgId={orgId} actorId={actorId} show={show} onChangeShow={() => setShow(null)} />;
  return (
    <Page backTo="/(app)/operations" title="Timecode">
      <OperationsPanel title="Choose a show" detail="Timecode and automation stay with the show you select.">
        {query.error ? <OperationsError message={query.error.message} /> : null}
        <AppButton label={query.isFetching ? "Loading shows…" : query.error ? "Retry loading shows" : "Refresh shows"} disabled={query.isFetching} variant="secondary" onPress={() => void query.refetch()} />
        {query.data?.shows.map(item => <AppButton key={item.id} label={`${item.name} · ${item.serviceDate}`} variant="secondary" onPress={() => setShow(item)} />)}
        {query.data?.shows.length === 0 ? <OperationsEmpty>Create a show before opening timecode.</OperationsEmpty> : null}
      </OperationsPanel>
    </Page>
  );
}

function TimecodeShow({ orgId, actorId, show, onChangeShow }: { orgId: string; actorId: string; show: MobileTimecodeShow; onChangeShow: () => void }) {
  const workspaceTerms = useWorkspaceTerms();
  const styles = useStyles();
  const target = { showId: show.id, serviceDate: show.serviceDate };
  const query = useQuery({
    queryKey: ["mobile-timecode", orgId, actorId, show.id, show.serviceDate],
    queryFn: () => getMobileTimecode(orgId, target),
    retry: false,
  });
  const [timecode, setTimecode] = useState("00:00:00:00");
  const [eventLabel, setEventLabel] = useState("");
  const [eventTimecode, setEventTimecode] = useState("00:00:10:00");
  const [eventAction, setEventAction] = useState<(typeof automationActions)[number][0]>("rundown-advance");
  const [eventPayload, setEventPayload] = useState("{}");
  const [error, setError] = useState("");
  const relay = useTimecodeRelay(orgId, query.data, target);
  const savedEvent = useRef<{ id: string; label: string } | null>(null);
  useEffect(() => {
    const saved = savedEvent.current;
    if (!saved || !relay.events.some(item => item.id === saved.id)) return;
    savedEvent.current = null;
    setEventLabel(current => current === saved.label ? "" : current);
  }, [relay.events]);
  const command = useMutation({
    mutationFn: commandMobileTimecode,
    onSuccess: () => {
      setError("");
      relay.refresh();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Timecode command failed."),
  });
  const data = relay.state ? { state: relay.state, events: relay.events } : query.data;

  const canEdit = relay.status === "connected" && relay.control === "yours" && !relay.pending && !command.isPending;

  const run = (action: Parameters<typeof commandMobileTimecode>[0]["action"], payload?: Record<string, unknown>) => {
    if (!canEdit) { setError("Claim control on a connected show before editing timecode."); return; }
    command.mutate({ orgId, ...target, action, payload });
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
    let payload: unknown;
    try {
      payload = JSON.parse(eventPayload);
    } catch {
      setError("Action details must be valid JSON.");
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      setError("Action details must be a JSON object."); return;
    }
    if (!canEdit) return;
    const id = `native-${createLocalRequestUuid()}`;
    savedEvent.current = { id, label: eventLabel };
    run("add-event", {
      id,
      label: eventLabel.trim(),
      triggerTimecode: parsed,
      triggerFrame: 0,
      action: eventAction,
      payload,
      fired: false,
      toleranceFrames: 5,
    });
  };

  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="SMPTE RELAY" title="Timecode" onRefresh={relay.refresh}>
      <OperationsPanel title={show.name} detail={show.serviceDate}>
        <AppButton label="Change show" variant="secondary" disabled={relay.isMaster || Boolean(relay.pending) || command.isPending} onPress={onChangeShow} />
      </OperationsPanel>
      {query.error && !relay.state ? <OperationsError message={query.error.message} /> : null}
      {error ? <OperationsError message={error} /> : null}
      {relay.lastError ? <OperationsError message={relay.lastError} /> : null}
      {relay.commandError ? <AppButton label="Dismiss command notice" variant="secondary" onPress={relay.dismissCommandError} /> : null}
      {relay.status !== "connected" ? <AppButton label="Retry live connection" variant="secondary" onPress={relay.retryConnection} /> : null}
      <OperationsPanel title="Control" detail={relay.status !== "connected" ? "Last known state. Live controls are unavailable until the show reconnects." : relay.control === "yours" ? "This device controls the selected show." : relay.control === "other" ? "Another operator controls this show. Ask them to release control." : "Viewing this show. Claim control to edit timecode and automation."}>
        {relay.control === "yours" ? <AppButton label="Release control" variant="secondary" disabled={relay.isMaster || Boolean(relay.pending) || command.isPending} onPress={relay.releaseControl} /> : <AppButton label="Claim control" disabled={relay.status !== "connected" || relay.control === "other" || Boolean(relay.pending)} onPress={relay.claimControl} />}
      </OperationsPanel>
      <View style={styles.clockCard}>
        <Text accessibilityLabel={`Timecode ${data?.state.display ?? "unavailable"}`} style={styles.clock}>{data?.state.display ?? "--:--:--:--"}</Text>
        <Text style={styles.clockMeta}>{data?.state.source.replaceAll("-", " ")} · {data?.state.format.frameRate} fps {data?.state.format.dropFrame.toUpperCase()} · {relay.status !== "connected" ? "last known" : data?.state.signal?.status === "timecode-lost" || data?.state.signal?.status === "timecode-stalled" ? data.state.signal.status.replaceAll("-", " ") : data?.state.running ? "running" : "stopped"} · {relay.status}{relay.isMaster ? " · this device is master" : ""}</Text>
      </View>
      <OperationsPanel title="Transport" detail="Control the shared relay used by web, desktop, overlays, and automation.">
        <View style={styles.buttonRow}>
          <View style={styles.button}><AppButton label="Start freerun" loading={relay.starting} disabled={!canEdit || relay.isMaster || data?.state.running} onPress={relay.startFreerun} /></View>
          <View style={styles.button}><AppButton label="Stop" variant="secondary" loading={relay.stopping} disabled={relay.status !== "connected" || relay.control !== "yours" || command.isPending} onPress={relay.stopFreerun} /></View>
        </View>
        <AppField label="Set timecode" value={timecode} onChangeText={setTimecode} autoCapitalize="characters" placeholder="00:00:00:00" />
        <AppButton label="Set relay time" variant="secondary" disabled={!canEdit || data?.state.running} onPress={setManualTimecode} />
      </OperationsPanel>
      {data?.state.lyrics ? (
        <OperationsPanel title={data.state.lyrics.songTitle} detail={data.state.lyrics.sectionLabel}><View style={styles.lyricsPreview}><Text style={styles.lyricsText}>{data.state.lyrics.lyrics.split(/\r?\n/).filter(Boolean).slice(0, 4).join("\n")}</Text><Text style={styles.lyricsNext}>{data.state.lyrics.nextLabel ? `NEXT · ${data.state.lyrics.nextLabel}` : "END OF SONG"}</Text></View></OperationsPanel>
      ) : null}
      <OperationsPanel title="Source and format" detail="This device can generate internal freerun. MTC, LTC, rundown, and network sources remain visible here when supplied by the desktop or bridge.">
        <View style={styles.buttonRow}>
          {[24, 25, 29.97, 30].map((frameRate) => (
            <View key={frameRate} style={styles.button}><AppButton label={`${frameRate}`} disabled={!canEdit || data?.state.running} variant={data?.state.format.frameRate === frameRate ? "primary" : "secondary"} onPress={() => run("set-format", { format: { frameRate, dropFrame: frameRate === 29.97 ? "df" : "ndf" } })} /></View>
          ))}
        </View>
      </OperationsPanel>
      <OperationsPanel title="Automation" detail="Create the same shared actions used by web and desktop. Events fire when the relay crosses the selected frame.">
        <AppField
          label="Event label"
          value={eventLabel}
          onChangeText={setEventLabel}
          placeholder={workspaceCopy("Advance to sermon", workspaceTerms)}
        />
        <AppField label="Trigger timecode" value={eventTimecode} onChangeText={setEventTimecode} placeholder="00:00:10:00" />
        <Text style={styles.fieldLabel}>ACTION</Text>
        <View style={styles.actionGrid}>
          {automationActions.map(([value, label]) => (
            <Pressable accessibilityRole="button" accessibilityState={{ selected: eventAction === value }} key={value} onPress={() => setEventAction(value)} style={[styles.actionChoice, eventAction === value && styles.actionChoiceActive]}><Text style={[styles.actionChoiceText, eventAction === value && styles.actionChoiceTextActive]}>{label}</Text></Pressable>
          ))}
        </View>
        <AppField label="Action details (JSON)" value={eventPayload} onChangeText={setEventPayload} multiline placeholder={eventAction === "stage-message" ? '{"message":"Stand by"}' : eventAction === "rundown-adjust" ? '{"deltaMs":30000}' : "{}"} />
        <AppButton label="Add automation event" disabled={!canEdit} onPress={addEvent} />
        {data?.events.length ? (
          data.events.map((event) => (
          <OperationsRow key={event.id} title={event.label} detail={`${event.triggerTimecode.hours.toString().padStart(2, "0")}:${event.triggerTimecode.minutes.toString().padStart(2, "0")}:${event.triggerTimecode.seconds.toString().padStart(2, "0")}:${event.triggerTimecode.frames.toString().padStart(2, "0")} · ${event.action}${event.executionError ? ` · ${event.executionError}` : ""}`} status={timecodeEventStatus(event)} onPress={canEdit ? () => Alert.alert("Remove automation event?", `Remove “${event.label}” from the shared timecode relay?`, [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => run("remove-event", { id: event.id }) }]) : undefined} />
        ))
        ) : (
          <OperationsEmpty>No automation events are armed.</OperationsEmpty>
        )}
        {data?.events.length ? (
          <AppButton label="Reset fired events" variant="secondary" disabled={!canEdit || data.state.running} onPress={() => Alert.alert("Re-arm all events?", "Previously fired events may run again when the clock reaches them.", [{ text: "Keep events", style: "cancel" }, { text: "Re-arm events", style: "destructive", onPress: () => run("reset-events") }])} />
        ) : null}
      </OperationsPanel>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  clockCard: { alignItems: "center", gap: 8, borderRadius: 22, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.black, paddingHorizontal: 12, paddingVertical: 28 },
  clock: { color: colors.amberText, fontFamily, fontSize: 39, fontWeight: "900", fontVariant: ["tabular-nums"], letterSpacing: 1 },
  clockMeta: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  fieldLabel: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 16, fontWeight: "800", letterSpacing: 1.1 },
  actionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  actionChoice: { minHeight: 44, justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 11 },
  actionChoiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  actionChoiceText: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 16, fontWeight: "700" },
  actionChoiceTextActive: { color: colors.amberText },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flex: 1, minWidth: 80 },
  lyricsPreview: { gap: 16, borderRadius: 18, backgroundColor: colors.black, paddingHorizontal: 18, paddingVertical: 28 },
  lyricsText: { color: colors.white, fontFamily, fontSize: 24, lineHeight: 31, fontWeight: "800", textAlign: "center" },
  lyricsNext: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "800", letterSpacing: 0.8 },
}));
