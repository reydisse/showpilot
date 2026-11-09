import { parseTimecodeString, workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/providers/workspace-provider";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useTimecodeCueSave } from "@/hooks/use-timecode-cue-save";
import { useTimecodeRelay } from "@/hooks/use-timecode-relay";
import { commandMobileTimecode, createMobileTimecodeCue, getMobileTimecode, getMobileTimecodeShows } from "@/lib/mobile-api";
import { timecodeEventStatus, type MobileTimecodeShow } from "@/lib/timecode-contract";
import { createThemedStyles, fontFamily } from "@/theme/tokens";

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
  const [error, setError] = useState("");
  const relay = useTimecodeRelay(orgId, query.data, target);
  const command = useMutation({
    mutationFn: commandMobileTimecode,
    onSuccess: () => {
      setError("");
      relay.refresh();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Timecode command failed."),
  });
  const data = relay.state ? { state: relay.state, events: relay.events } : query.data;

  const canControl = relay.status === "connected" && relay.control === "yours" && !relay.pending && !command.isPending;
  const cueSave = useTimecodeCueSave({ orgId, userId: actorId, ...target }, {
    active: true, canSend: canControl, format: data?.state.format, send: createMobileTimecodeCue,
    refresh: async signal => {
      if (!await relay.refresh() || signal.aborted) throw new Error("The timeline refresh was not confirmed. Retry to load its current state.");
    },
  });
  const draft = cueSave.draft;
  const save = cueSave.attempt;
  const formatChanged = Boolean(draft.format && data && (draft.format.frameRate !== data.state.format.frameRate || draft.format.dropFrame !== data.state.format.dropFrame));
  const canEdit = canControl && !cueSave.locked;

  const run = (action: Parameters<typeof commandMobileTimecode>[0]["action"], payload?: Record<string, unknown>) => {
    if (!canEdit) { setError("Claim control on a connected show before editing timecode."); return; }
    command.mutate({ orgId, ...target, action, payload });
  };
  const setManualTimecode = () => {
    const parsed = data ? parseTimecodeString(timecode.trim(), data.state.format) : null;
    if (!parsed || (data && parsed.frames >= Math.round(data.state.format.frameRate))) {
      setError("Enter a valid SMPTE timecode for the selected frame rate.");
      return;
    }
    run("set-timecode", { timecode: parsed });
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
      <OperationsPanel title="Automation" detail="Events fire when the relay crosses the selected frame. Cue drafts and unconfirmed saves stay with this show when you leave the screen.">
        {cueSave.error ? <OperationsError message={cueSave.error} /> : null}
        {save ? <View style={styles.saveNotice}>
          <Text accessibilityRole="alert" style={styles.saveText}>{save.kind === "pending" ? "Saving cue… Your draft is kept." : save.kind === "failed" ? save.message : save.result.outcome === "applied" ? "Cue saved. Refreshing or retrying this save will preserve later edits." : save.result.message ?? "Review the cue save result."}</Text>
          {save.kind === "failed" ? <AppButton label="Retry original cue save" disabled={!canControl} onPress={cueSave.retry} /> : null}
          {save.kind === "confirmed" && save.refresh === "pending" ? <Text style={styles.saveText}>Refreshing timeline…</Text> : null}
          {save.kind === "confirmed" && (save.refresh === "failed" || save.refresh === "idle") ? <><OperationsError message={save.message ?? "The cue result is known. Refresh the current timeline before continuing."} /><AppButton label="Retry timeline refresh" disabled={relay.status !== "connected"} onPress={cueSave.refresh} /></> : null}
          {save.kind === "confirmed" && save.refresh === "done" ? <View style={styles.buttonRow}>
            <View style={styles.button}><AppButton label="New cue" variant="secondary" onPress={() => cueSave.finish(false)} /></View>
            {save.result.outcome !== "applied" ? <View style={styles.button}><AppButton label="Review retained draft" variant="secondary" onPress={() => cueSave.finish(true)} /></View> : null}
          </View> : null}
        </View> : null}
        {draft.format ? <Text style={styles.saveText}>Cue time reviewed at {draft.format.frameRate} fps {draft.format.dropFrame.toUpperCase()}.</Text> : null}
        {formatChanged ? <><OperationsError message="The show's frame rate changed. Review the cue time before using the current format." /><AppButton label="Use current frame rate" variant="secondary" disabled={cueSave.locked} onPress={cueSave.reviewFormat} /></> : null}
        <AppField
          label="Event label"
          value={draft.label}
          onChangeText={label => cueSave.update({ label })}
          editable={!cueSave.locked}
          placeholder={workspaceCopy("Advance to sermon", workspaceTerms)}
        />
        <AppField label="Trigger timecode" value={draft.timecode} editable={!cueSave.locked} onChangeText={timecode => cueSave.update({ timecode })} placeholder="00:00:10:00" />
        <Text style={styles.fieldLabel}>ACTION</Text>
        <View style={styles.actionGrid}>
          {automationActions.map(([value, label]) => (
            <Pressable accessibilityRole="button" accessibilityState={{ selected: draft.action === value, disabled: cueSave.locked }} key={value} disabled={cueSave.locked} onPress={() => cueSave.update({ action: value })} style={[styles.actionChoice, draft.action === value && styles.actionChoiceActive]}><Text style={[styles.actionChoiceText, draft.action === value && styles.actionChoiceTextActive]}>{label}</Text></Pressable>
          ))}
        </View>
        <AppField label="Action details (JSON)" value={draft.payload} editable={!cueSave.locked} onChangeText={payload => cueSave.update({ payload })} multiline placeholder={draft.action === "stage-message" ? '{"message":"Stand by"}' : draft.action === "rundown-adjust" ? '{"deltaMs":30000}' : "{}"} />
        <AppButton label="Add automation event" disabled={!canControl || cueSave.locked || formatChanged} onPress={cueSave.save} />
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
  saveNotice: { gap: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, padding: 12 },
  saveText: { color: colors.text, fontFamily, fontSize: 13, lineHeight: 19 },
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
