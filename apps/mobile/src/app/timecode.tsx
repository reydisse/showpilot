import { TimecodeCueEditor } from "@/components/timecode-cue-editor";
import { TimecodeCueFields } from "@/components/timecode-cue-fields";
import { useTimecodeCueEdit } from "@/hooks/use-timecode-cue-edit";
import { AUTOMATION_ACTIONS } from "@showpilot/shared";
import { TimecodeCueConfirmation } from "@/components/timecode-cue-confirmation";
import { useTimecodeCueControls } from "@/hooks/use-timecode-cue-controls";
import { useTimecodeAutomationGate } from "@/hooks/use-timecode-automation-gate";
import { TimecodeClockConfirmation } from "@/components/timecode-clock-confirmation";
import { useTimecodeClockEdit } from "@/hooks/use-timecode-clock-edit";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useTimecodeCueSave } from "@/hooks/use-timecode-cue-save";
import { useTimecodeRelay } from "@/hooks/use-timecode-relay";
import { controlMobileTimecodeCues, createMobileTimecodeCue, editMobileTimecodeCue, editMobileTimecodeClock, editMobileTimecodeAutomation, getMobileTimecode, getMobileTimecodeShows } from "@/lib/mobile-api";
import { timecodeEventStatus, type MobileTimecodeShow } from "@/lib/timecode-contract";
import { createThemedStyles, fontFamily } from "@/theme/tokens";



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
  const [cueValid, setCueValid] = useState(false);
  const styles = useStyles();
  const target = { showId: show.id, serviceDate: show.serviceDate };
  const query = useQuery({
    queryKey: ["mobile-timecode", orgId, actorId, show.id, show.serviceDate],
    queryFn: () => getMobileTimecode(orgId, target),
    retry: false,
  });
  const relay = useTimecodeRelay(orgId, query.data, target);
  const data = relay.state ? { state: relay.state, events: relay.events } : query.data;

  const canControl = relay.status === "connected" && relay.control === "yours" && !relay.pending;
  const clockEdit = useTimecodeClockEdit({ orgId, userId: actorId, ...target }, {
    active: true, canSend: canControl, state: data?.state, send: editMobileTimecodeClock,
    refresh: async signal => { if (!await relay.refresh() || signal.aborted) throw new Error("The current clock could not refresh. Retry its refresh."); },
  });
  const cueEdit = useTimecodeCueEdit({ orgId, userId: actorId, ...target }, {
    active: true, canSend: canControl && !clockEdit.locked, format: data?.state.format, events: data?.events ?? [], send: editMobileTimecodeCue,
    refresh: async signal => { if (!await relay.refresh() || signal.aborted) throw new Error("The edited timeline could not refresh. Retry the refresh."); },
  });
  const cueSave = useTimecodeCueSave({ orgId, userId: actorId, ...target }, {
    active: true, canSend: canControl && !clockEdit.locked && !cueEdit.locked, format: data?.state.format, send: createMobileTimecodeCue,
    refresh: async signal => {
      if (!await relay.refresh() || signal.aborted) throw new Error("The timeline refresh was not confirmed. Retry to load its current state.");
    },
  });
  const draft = cueSave.draft;
  const save = cueSave.attempt;
  const formatChanged = Boolean(draft.format && data && (draft.format.frameRate !== data.state.format.frameRate || draft.format.dropFrame !== data.state.format.dropFrame));
  const gate = useTimecodeAutomationGate({ orgId, userId: actorId, ...target }, {
    active: true, canSend: relay.status === "connected" && relay.control === "yours",
    canResume: canControl && !cueSave.locked && !clockEdit.locked && !cueEdit.locked, state: data?.state, send: editMobileTimecodeAutomation,
    refresh: async signal => { if (!await relay.refresh() || signal.aborted) throw new Error("The current automation state could not refresh. Retry its refresh."); },
  });
  const cueControls = useTimecodeCueControls({ orgId, userId: actorId, ...target }, {
    active: true, canSend: canControl && !cueSave.locked && !clockEdit.locked && !gate.locked && !cueEdit.locked,
    state: data?.state, events: data?.events ?? [], send: controlMobileTimecodeCues,
    refresh: async signal => { if (!await relay.refresh() || signal.aborted) throw new Error("The current cues could not refresh. Retry their refresh."); },
  });
  const cueAttempt = cueControls.attempt;
  const canSaveEdit = canControl && !cueSave.locked && !clockEdit.locked && !gate.locked && !cueControls.locked;
  const canEdit = canSaveEdit && !cueEdit.locked;

  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="SMPTE RELAY" title="Timecode" onRefresh={relay.refresh}>
      {cueEdit.error && !cueEdit.draft ? <OperationsError message={cueEdit.error} /> : null}
      {cueControls.review ? <TimecodeCueConfirmation review={cueControls.review} showName={show.name}
        changed={cueControls.changed} active={cueControls.canReview} error={cueControls.error} onCancel={cueControls.cancel}
        onReview={cueControls.reviewCurrent} onConfirm={cueControls.confirm} /> : null}
      {clockEdit.draft.review ? <TimecodeClockConfirmation review={clockEdit.draft.review} showName={show.name}
        changed={clockEdit.reviewChanged} active={clockEdit.canReview && !cueSave.locked} onCancel={clockEdit.cancel}
        onReview={clockEdit.reviewCurrent} onConfirm={clockEdit.confirm} /> : null}
      <OperationsPanel title={show.name} detail={show.serviceDate}>
        <AppButton label="Change show" variant="secondary" disabled={relay.isMaster || Boolean(relay.pending)} onPress={onChangeShow} />
      </OperationsPanel>
      {query.error && !relay.state ? <OperationsError message={query.error.message} /> : null}
      {relay.lastError ? <OperationsError message={relay.lastError} /> : null}
      {relay.commandError ? <AppButton label="Dismiss command notice" variant="secondary" onPress={relay.dismissCommandError} /> : null}
      {relay.status !== "connected" ? <AppButton label="Retry live connection" variant="secondary" onPress={relay.retryConnection} /> : null}
      <OperationsPanel title="Control" detail={relay.status !== "connected" ? "Last known state. Live controls are unavailable until the show reconnects." : relay.control === "yours" ? "This device controls the selected show." : relay.control === "other" ? "Another operator controls this show. Ask them to release control." : "Viewing this show. Claim control to edit timecode and automation."}>
        {relay.control === "yours" ? <AppButton label="Release control" variant="secondary" disabled={relay.isMaster || Boolean(relay.pending)} onPress={relay.releaseControl} /> : <AppButton label="Claim control" disabled={relay.status !== "connected" || relay.control === "other" || Boolean(relay.pending)} onPress={relay.claimControl} />}
      </OperationsPanel>
      <View style={styles.clockCard}>
        <Text accessibilityLabel={`Timecode ${data?.state.display ?? "unavailable"}`} style={styles.clock}>{data?.state.display ?? "--:--:--:--"}</Text>
        <Text style={styles.clockMeta}>{data?.state.source.replaceAll("-", " ")} · {data?.state.format.frameRate} fps {data?.state.format.dropFrame.toUpperCase()} · {relay.status !== "connected" ? "last known" : data?.state.signal?.status === "timecode-lost" || data?.state.signal?.status === "timecode-stalled" ? data.state.signal.status.replaceAll("-", " ") : data?.state.running ? "running" : "stopped"} · {relay.status}{relay.isMaster ? " · this device is master" : ""}</Text>
      </View>
      <OperationsPanel title="Automation safety" detail={relay.status !== "connected" ? "Last known automation state. Reconnect to control this show."
        : !data?.state.triggersEnabled ? "Automation stopped. Manual and automatic cues are blocked."
        : data.state.automaticCuesEnabled ? "Automation enabled. Upcoming cues can fire." : "Automatic cues paused. Manual cue firing remains available."}>
        <AppButton label="Stop automation" variant="danger" loading={gate.stopping} disabled={relay.status !== "connected" || relay.control !== "yours" || gate.stopping} onPress={gate.stop} />
        <Text style={styles.saveText}>Stops new cue dispatches. The clock and existing output continue; commands already sent cannot be recalled.</Text>
        {gate.error ? <OperationsError message={gate.error} /> : null}
        {!data?.state.triggersEnabled ? <AppButton label="Review resume automation" variant="secondary" disabled={!canEdit || !data?.state.automationRevision} onPress={() => gate.prepare("resume")} />
          : data.state.automaticCuesEnabled === false ? <AppButton label="Review automatic cues" variant="secondary" disabled={!canEdit || !data.state.automationRevision} onPress={() => gate.prepare("resume-automatic")} /> : null}
        {gate.review ? <View style={styles.saveNotice}>
          <Text accessibilityRole="header" style={styles.saveText}>{gate.review.command.operation === "resume" ? "Resume automation?" : "Resume automatic cues?"}</Text>
          <Text style={styles.saveText}>Show: {show.name}. {gate.review.reason} Cues resume from the current clock position. Crossed cues are not replayed and fired cues remain fired.</Text>
          {gate.review.command.operation === "resume" && data?.state.automaticCuesEnabled === false ? <Text style={styles.saveText}>Automatic cues remain paused until you resume them separately.</Text> : null}
          {gate.changed ? <><OperationsError message="Automation changed after review. Review its current state before confirming." /><AppButton label="Review current automation" variant="secondary" disabled={!gate.canReview} onPress={gate.reviewCurrent} /></> : null}
          {!gate.canReview ? <OperationsError message="Connect, claim control and resolve pending changes before confirming." /> : null}
          <AppButton label="Keep automation paused" variant="secondary" onPress={gate.cancel} />
          <AppButton label="Confirm resume" disabled={!gate.canReview || gate.changed} onPress={gate.confirm} />
        </View> : null}
        {Object.entries(gate.work).map(([id, attempt]) => <View key={id} style={styles.saveNotice}>
          <Text accessibilityRole="header" style={styles.saveText}>{attempt.label}</Text>
          <Text accessibilityRole="alert" style={styles.saveText}>{attempt.kind === "pending" ? "Waiting for the relay to confirm…" : attempt.kind === "failed" ? attempt.message
            : attempt.result.outcome === "applied" ? "Automation change confirmed. Later changes are preserved." : attempt.result.message ?? "The automation change was not applied."}</Text>
          {attempt.kind === "failed" ? <AppButton label={`Retry original ${attempt.label.toLowerCase()}`} disabled={relay.status !== "connected" || relay.control !== "yours"} onPress={() => gate.retry(id)} /> : null}
          {attempt.kind === "confirmed" && attempt.refresh === "pending" ? <Text style={styles.saveText}>Refreshing current automation…</Text> : null}
          {attempt.kind === "confirmed" && (attempt.refresh === "failed" || attempt.refresh === "idle") ? <><OperationsError message={attempt.message ?? "Refresh the current automation state."} /><AppButton label="Retry automation refresh" disabled={relay.status !== "connected"} onPress={() => gate.refresh(id)} /></> : null}
          {attempt.kind === "confirmed" && attempt.refresh === "done" ? <AppButton label="Continue with current automation" variant="secondary" onPress={() => gate.finish(id)} /> : null}
        </View>)}
      </OperationsPanel>
      {data?.state.automationHold ? <OperationsError message={`Automation paused for review after the clock jumped from ${data.state.automationHold.from} to ${data.state.automationHold.to}.`} /> : null}
      {data?.state.incomingFormat ? <OperationsError message={`Input format needs review: ${data.state.incomingFormat.format.frameRate} fps ${data.state.incomingFormat.format.dropFrame.toUpperCase()}.`} /> : null}
      {clockEdit.error ? <OperationsError message={clockEdit.error} /> : null}
      {clockEdit.attempt ? <OperationsPanel title="Clock change" detail={clockEdit.attempt.label}>
        <Text accessibilityRole="alert" style={styles.saveText}>{clockEdit.attempt.kind === "pending" ? "Confirming the clock change…" : clockEdit.attempt.kind === "failed" ? clockEdit.attempt.message
          : clockEdit.attempt.result.outcome === "applied" ? "Clock change confirmed. Later clock changes are preserved." : clockEdit.attempt.result.message ?? "The clock change was not applied."}</Text>
        {clockEdit.attempt.kind === "failed" ? <AppButton label="Retry original clock change" disabled={!canControl} onPress={clockEdit.retry} /> : null}
        {clockEdit.attempt.kind === "confirmed" && clockEdit.attempt.refresh === "pending" ? <Text style={styles.saveText}>Refreshing current clock…</Text> : null}
        {clockEdit.attempt.kind === "confirmed" && (clockEdit.attempt.refresh === "failed" || clockEdit.attempt.refresh === "idle") ? <><OperationsError message={clockEdit.attempt.message ?? "Refresh the current clock before continuing."} /><AppButton label="Retry clock refresh" disabled={relay.status !== "connected"} onPress={clockEdit.refresh} /></> : null}
        {clockEdit.attempt.kind === "confirmed" && clockEdit.attempt.refresh === "done" ? <AppButton label="Continue with current clock" variant="secondary" onPress={clockEdit.finish} /> : null}
      </OperationsPanel> : null}
      <OperationsPanel title="Transport" detail="Control the shared relay used by web, desktop, overlays, and automation.">
        <View style={styles.buttonRow}>
          <View style={styles.button}><AppButton label="Start freerun" loading={relay.starting} disabled={!canEdit || relay.isMaster || data?.state.running} onPress={relay.startFreerun} /></View>
          <View style={styles.button}><AppButton label="Stop" variant="secondary" loading={relay.stopping} disabled={relay.status !== "connected" || relay.control !== "yours"} onPress={relay.stopFreerun} /></View>
        </View>
        <AppField label="Set timecode" value={clockEdit.draft.timecode} editable={!clockEdit.locked} onChangeText={clockEdit.update} autoCapitalize="characters" placeholder="00:00:00:00" />
        <AppButton label="Set relay time" variant="secondary" disabled={!canEdit || data?.state.running} onPress={() => clockEdit.prepare("seek")} />
      </OperationsPanel>
      {data?.state.lyrics ? (
        <OperationsPanel title={data.state.lyrics.songTitle} detail={data.state.lyrics.sectionLabel}><View style={styles.lyricsPreview}><Text style={styles.lyricsText}>{data.state.lyrics.lyrics.split(/\r?\n/).filter(Boolean).slice(0, 4).join("\n")}</Text><Text style={styles.lyricsNext}>{data.state.lyrics.nextLabel ? `NEXT · ${data.state.lyrics.nextLabel}` : "END OF SONG"}</Text></View></OperationsPanel>
      ) : null}
      <OperationsPanel title="Source and format" detail="This device can generate internal freerun. MTC, LTC, rundown, and network sources remain visible here when supplied by the desktop or bridge.">
        <View style={styles.buttonRow}>
          {([{ frameRate: 24, dropFrame: "ndf" }, { frameRate: 25, dropFrame: "ndf" }, { frameRate: 29.97, dropFrame: "ndf" }, { frameRate: 29.97, dropFrame: "df" }, { frameRate: 30, dropFrame: "ndf" }] as const).map((format) => (
            <View key={`${format.frameRate}:${format.dropFrame}`} style={styles.button}><AppButton label={`${format.frameRate} fps ${format.dropFrame.toUpperCase()}`} disabled={!canEdit || data?.state.running} variant={data?.state.format.frameRate === format.frameRate && data.state.format.dropFrame === format.dropFrame ? "primary" : "secondary"} onPress={() => clockEdit.prepare("reformat", format)} /></View>
          ))}
        </View>
      </OperationsPanel>
      <TimecodeCueEditor scope={{ orgId, userId: actorId, showId: show.id }} editor={cueEdit} canSave={canSaveEdit} connected={relay.status === "connected"} />
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
        {!cueEdit.draft ? <>
        {draft.format ? <Text style={styles.saveText}>Cue time reviewed at {draft.format.frameRate} fps {draft.format.dropFrame.toUpperCase()}.</Text> : null}
        {formatChanged ? <><OperationsError message="The show's frame rate changed. Review the cue time before using the current format." /><AppButton label="Use current frame rate" variant="secondary" disabled={cueSave.locked} onPress={cueSave.reviewFormat} /></> : null}
        <TimecodeCueFields scope={{ orgId, userId: actorId, showId: show.id }} draft={draft} update={cueSave.update} disabled={cueSave.locked || cueEdit.locked} onValid={setCueValid} />
        <AppButton label="Add automation event" disabled={!canControl || cueSave.locked || cueEdit.locked || gate.locked || cueControls.locked || clockEdit.locked || formatChanged || !cueValid} onPress={cueSave.save} />
        </> : null}

        {cueControls.error ? <OperationsError message={cueControls.error} /> : null}
        {cueAttempt ? <View style={styles.saveNotice}>
          <Text accessibilityRole="header" style={styles.saveText}>{cueAttempt.label}</Text>
          <Text accessibilityRole="alert" style={styles.saveText}>{cueAttempt.kind === "pending" ? "Waiting for the relay to confirm the cue action…" : cueAttempt.kind === "failed" ? cueAttempt.message
            : cueAttempt.result.outcome !== "applied" ? cueAttempt.result.message ?? "The cue action was not applied."
            : ["fire", "retry", "refire"].includes(cueAttempt.command.operation) ? "Cue request accepted. Check its delivery status in the timeline. Recovery will not send it again."
            : "Cue change confirmed. Later changes are preserved."}</Text>
          {cueAttempt.kind === "failed" ? <AppButton label="Retry original cue action" disabled={!canControl} onPress={cueControls.retry} /> : null}
          {cueAttempt.kind === "confirmed" && cueAttempt.refresh === "pending" ? <Text style={styles.saveText}>Refreshing current cues…</Text> : null}
          {cueAttempt.kind === "confirmed" && (cueAttempt.refresh === "failed" || cueAttempt.refresh === "idle") ? <><OperationsError message={cueAttempt.message ?? "Refresh the current cues before continuing."} /><AppButton label="Retry cue action refresh" disabled={relay.status !== "connected"} onPress={cueControls.refresh} /></> : null}
          {cueAttempt.kind === "confirmed" && cueAttempt.refresh === "done" ? <AppButton label="Continue with current cues" variant="secondary" onPress={cueControls.finish} /> : null}
        </View> : null}
        {data?.events.length ? data.events.map(event => <OperationsPanel key={event.id} title={event.label}
          detail={`${[event.triggerTimecode.hours, event.triggerTimecode.minutes, event.triggerTimecode.seconds, event.triggerTimecode.frames].map(value => String(value).padStart(2, "0")).join(":")} · ${AUTOMATION_ACTIONS.find(option => option.value === event.action)?.label ?? event.action}`}>
          <Text style={styles.saveText}>{timecodeEventStatus(event)}{!event.enabled && (event.executionStatus === "failed" || event.executionStatus === "dispatching") ? " · Disabled" : ""}</Text>
          {event.executionError ? <OperationsError message={event.executionError} /> : null}
          <View style={styles.buttonRow}>
            <View style={styles.cueButton}><AppButton label="Edit" accessibilityLabel={`Edit cue ${event.label}`} variant="secondary" disabled={!canEdit || event.executionStatus === "dispatching"} onPress={() => cueEdit.begin(event.id)} /></View>
            <View style={styles.cueButton}><AppButton label={event.enabled ? "Disable" : "Enable"} accessibilityLabel={`${event.enabled ? "Disable" : "Enable"} cue ${event.label}`} variant="secondary" disabled={!canEdit}
              onPress={() => cueControls.prepare(event.enabled ? "disable" : "enable", event.id)} /></View>
            {event.enabled && !event.skipped && event.executionStatus !== "dispatching" ? <View style={styles.cueButton}><AppButton
              label={event.executionStatus === "failed" ? "Retry" : event.fired ? "Fire again" : "Fire now"}
              accessibilityLabel={`${event.executionStatus === "failed" ? "Retry" : event.fired ? "Fire again" : "Fire now"} cue ${event.label}`}
              disabled={!canEdit || !data.state.triggersEnabled} onPress={() => cueControls.prepare(event.executionStatus === "failed" ? "retry" : event.fired ? "refire" : "fire", event.id)} /></View> : null}
            {event.fired || event.skipped || event.executionStatus === "failed" ? <View style={styles.cueButton}><AppButton label="Re-arm" accessibilityLabel={`Re-arm cue ${event.label}`} variant="secondary"
              disabled={!canEdit || event.executionStatus === "dispatching"} onPress={() => cueControls.prepare("rearm", event.id)} /></View> : null}
            <View style={styles.cueButton}><AppButton label="Remove" accessibilityLabel={`Remove cue ${event.label}`} variant="danger" disabled={!canEdit || event.executionStatus === "dispatching"} onPress={() => cueControls.prepare("remove", event.id)} /></View>
          </View>
        </OperationsPanel>) : <OperationsEmpty>No automation cues in this show.</OperationsEmpty>}
        {data?.events.length ? <AppButton label="Re-arm all cues" variant="secondary" disabled={!canEdit || data.state.running || data.events.some(event => event.executionStatus === "dispatching")} onPress={() => cueControls.prepare("reset")} /> : null}
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
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flex: 1, minWidth: 80 },
  cueButton: { flex: 1, minWidth: 100 },
  lyricsPreview: { gap: 16, borderRadius: 18, backgroundColor: colors.black, paddingHorizontal: 18, paddingVertical: 28 },
  lyricsText: { color: colors.white, fontFamily, fontSize: 24, lineHeight: 31, fontWeight: "800", textAlign: "center" },
  lyricsNext: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "800", letterSpacing: 0.8 },
}));
