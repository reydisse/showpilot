import { TimecodeTransport } from "@/components/timecode/TimecodeTransport";
import { NamedTimers } from "@/components/timers/NamedTimers";
import { MediaLibrary } from "@/components/timecode/MediaLibrary";
import { MediaOutputPanel } from "@/components/timecode/MediaOutputPanel";
import { getBlackoutTargets } from "@/lib/automation-targets";
import { getRundownState } from "@/lib/rundown";
import type { AutomationTargetKind } from "@/components/timecode/AutomationTargetPicker";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { useCallback, useMemo, useState } from "react";
import { LyricsControls } from "@/components/timecode/LyricsControls";
import { ConfidenceSlide } from "@/components/confidence/ConfidenceSlide";
import { readConfidenceLayout, CONFIDENCE_LAYOUT_KEY } from "@/lib/confidence-layout";
import { createFileRoute } from "@tanstack/react-router";
import { FileDown, Music2 } from "lucide-react";
import { useShowTimecode, TimecodeShowPicker, TimecodeControlNotice } from "@/components/timecode/TimecodeContext";
import { TimecodeAutomationControl } from "@/components/timecode/TimecodeAutomationControl";
import { MidiControllerPanel } from "@/components/timecode/MidiController";
import { TimecodeDisplay } from "@/components/timecode/TimecodeDisplay";
import { TimecodeSourceSelector } from "@/components/timecode/TimecodeSourceSelector";
import { AutomationTimelinePanel } from "@/components/timecode/AutomationTimelinePanel";
import { AutomationEventEditor } from "@/components/timecode/AutomationEventEditor";
import { createBrowserId } from "@/lib/browser-id";
import { sameTimecodeFormat, timecodeToFrames } from "@/lib/timecode";
import { automationEditReview, automationEditReviewMatches } from "@/lib/automation-edit";
import type { AutomationEvent, TimecodeFormat } from "@/types/timecode";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SongCueLoader } from "@/components/timecode/SongCueLoader";
import { demoEventsForWorkspace } from "@/lib/seed-timecode-demo";
import { getOrgSettings } from "@/lib/settings";

export const Route = createFileRoute("/$slug/timecode")({
  beforeLoad: async ({ context, params }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "timecode:access", params.slug, context.orgId);
  },
  loader: async ({ context }) => ({ settings: await getOrgSettings({ data: { orgId: context.orgId } }) }),
  component: TimecodePage,
});

function lyricsTarget(value: string | undefined): "native" | "propresenter" | "both" {
  return value === "native" || value === "propresenter" ? value : "both";
}

function TimecodePage() {
  const workspace = useWorkspace();
  const { slug } = Route.useParams();
  const { orgId } = Route.useRouteContext() as { orgId: string };
  const { settings } = Route.useLoaderData();
  const lyricsLayout = useMemo(() => {
    const layout = readConfidenceLayout(settings[CONFIDENCE_LAYOUT_KEY]);
    return { ...layout, contentMode: "lyrics" as const, lyrics: { ...layout.lyrics, showNext: false, showReference: false } };
  }, [settings]);

  const timecode = useShowTimecode();
  const {
    state,
    connected,
    control,
    events,
    isMaster,
    generatorPending,
    lastError, lastErrorAt, retryConnection,
    startFreerun,
    stopGenerator,
    pauseGenerator,
    startMtc,
    setFormat,
    addEvent,
    replaceEventGroup,
    removeEvent,
    resetEvents,
    retryEvent,
    fireEvent,
    fireNext,
    skipEvent,
    rearmEvent,
    setEventEnabled,
    setTriggersEnabled, resumeAutomaticCues,
    mtcSupported,
  } = timecode;

  const selectedShow = timecode.shows.find(show => show.id === timecode.showId);
  const loadTargets = useCallback(async (kind: AutomationTargetKind) => {
    if (kind === "lighting-blackout") return getBlackoutTargets({ data: { orgId } });
    if (!selectedShow) throw new Error("Select a show before choosing a rundown item.");
    const rundown = await getRundownState({ data: { orgId, showId: selectedShow.id, serviceDate: selectedShow.serviceDate } });
    return rundown.items.filter(item => item.type !== "header").map(item => ({ id: item.id, label: item.title }));
  }, [orgId, selectedShow]);

  const [demoLoaded, setDemoLoaded] = useState(false);
  const [demoPending, setDemoPending] = useState(false);
  const [songLoaderOpen, setSongLoaderOpen] = useState(false);
  const [editing, setEditing] = useState<{ event: AutomationEvent; format: TimecodeFormat; showId: string; generation: number } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const currentEdit = editing?.showId === timecode.showId ? events.find(event => event.id === editing.event.id) : undefined;
  const editChanged = editing && (!currentEdit || !automationEditReviewMatches(currentEdit, automationEditReview(editing.event))
    || !state || !sameTimecodeFormat(editing.format, state.format));

  async function loadDemo() {
    if (!connected || state?.running || events.length > 0 || demoPending) return;
    setDemoPending(true);
    try {
      const sourceKey = `demo:${workspace.type}`;
      const format = state?.format ?? { frameRate: 30, dropFrame: "ndf" as const };
      const demo = demoEventsForWorkspace(workspace.type).map((event) => ({
        ...event, id: createBrowserId(), sourceKey, fired: false,
        triggerFrame: timecodeToFrames(event.triggerTimecode, format),
      }));
      await replaceEventGroup(sourceKey, demo, { onlyIfEmpty: true });
      setDemoLoaded(true);
    }
    catch { /* The hook exposes the relay confirmation error below. */ }
    finally { setDemoPending(false); }
  }

  return (
    <div data-timecode-page className="h-full overflow-auto">
      <div data-timecode-header className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              SMPTE Timecode
            </h1>
            <p className="hidden text-xs text-board-muted mt-0.5 sm:block">
              Show automation sequencer
            </p>
          </div>
          <TimecodeTransport key={timecode.showId} state={state} connected={connected} canControl={control !== "other"} isMaster={isMaster} pending={generatorPending}
            onStart={startFreerun} onStop={stopGenerator} onPause={pauseGenerator} />
        </div>
      </div>

      <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
        <Button type="button" variant="outline" disabled={!connected || state?.running || generatorPending !== null} onClick={() => setSongLoaderOpen(true)} className="min-h-11 text-xs"><Music2 />Load song cues</Button>
        <TimecodeShowPicker />
        <TimecodeControlNotice />
        {!connected && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">
          <p>{state ? "Reconnecting, showing last known timecode state." : lastError ? "Reconnecting to timecode." : "Connecting to timecode…"} Controls will be available after the show state is confirmed.</p>
          {lastError && <Button type="button" variant="outline" className="min-h-11" onClick={retryConnection}>Reconnect timecode</Button>}
        </div>}
        {lastError && <p role="alert" data-timecode-error className="rounded-xl border border-red-500/40 p-4 text-sm text-red-300">
          Last error: {lastError} {lastErrorAt !== null && <time dateTime={new Date(lastErrorAt).toISOString()}>{new Date(lastErrorAt).toLocaleTimeString()}</time>}
        </p>}
        <TimecodeAutomationControl state={state} connected={connected} canControl={control !== "other"} onSetEnabled={setTriggersEnabled} onResumeAutomaticCues={resumeAutomaticCues} />
        <NamedTimers sample={state?.namedTimers ?? null} connected={connected} outputTarget={timecode.showId ? { orgSlug: slug, showId: timecode.showId } : undefined} />
        <MediaOutputPanel orgSlug={slug} showId={timecode.showId} connected={connected} outputs={state?.mediaOutputs ?? []} />
        {/* Large TC display */}
        <div className="rounded-xl border border-board-border bg-board-card p-4 sm:p-8">
          <TimecodeDisplay state={state} connected={connected} size="large" />
        </div>

        {/* Large TC display */}
        <TimecodeSourceSelector
          key={`source:${timecode.showId}`}
          isMaster={isMaster}
          connected={connected && control !== "other"}
          pending={generatorPending}
          running={state?.running ?? false}
          signal={state?.signal}
          source={state?.source}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
          incomingFormat={state?.incomingFormat}
          mtcSupported={mtcSupported}
          onStartMtc={startMtc}
          onSetFormat={setFormat}
        />

        {/* Large TC display */}
        <MidiControllerPanel key={timecode.showId} timecode={timecode} />
        <AutomationTimelinePanel key={`timeline:${orgId}`} orgId={orgId}
          events={events}
          state={state}
          onRemoveEvent={removeEvent}
          onResetEvents={resetEvents}
          onRetryEvent={retryEvent}
          onFireEvent={fireEvent}
          onFireNext={fireNext}
          onSkipEvent={skipEvent}
          onRearmEvent={rearmEvent}
          onSetEventEnabled={setEventEnabled}
          onEditEvent={event => { if (state && timecode.showId) setEditing({ event: structuredClone(event), format: { ...state.format }, showId: timecode.showId, generation: 0 }); }}
          connected={connected && control !== "other"}
        />

        {events.length === 0 && !demoLoaded && !state?.running && connected && (
          <section className="rounded-xl border border-board-border p-4 text-sm text-board-muted">
            <p>Try a sample automation timeline in this empty workspace.</p>
            <button type="button" disabled={demoPending} onClick={() => { void loadDemo(); }} className="mt-3 flex min-h-11 items-center gap-2 rounded-lg border border-board-border px-3 text-board-text"><FileDown className="h-4 w-4" />Load Demo Show</button>
          </section>
        )}
        {/* Add event */}
        <AutomationEventEditor
          key={`${orgId}:${timecode.showId}`}
          orgId={orgId}
          loadTargets={loadTargets}
          timerNames={[...new Set([...events.filter(event => event.action === "timer-start").flatMap(event => typeof event.payload.name === "string" ? [event.payload.name] : []), ...(state?.namedTimers?.timers.map(timer => timer.name) ?? [])])]}
          onAdd={addEvent}
          connected={connected && control !== "other"}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
        />

        {state?.lyrics ? (
          <section aria-label="Live lyrics" className="overflow-hidden rounded-xl border border-board-border bg-black">
            <div className="border-b border-white/10 px-4 py-3"><h2 className="text-sm font-semibold text-white">{state.lyrics.songTitle}</h2><p className="text-xs uppercase tracking-wider text-amber-400">{state.lyrics.sectionLabel}</p></div>
            <div className="h-[clamp(15rem,40vh,32rem)] p-4 sm:p-6"><ConfidenceSlide layout={lyricsLayout} slide={{ text: state.lyrics.lyrics, slideId: state.lyrics.sectionId, presentationName: state.lyrics.songTitle, notes: "", isScripture: false }} /></div>
            <div className="space-y-3 border-t border-white/10 px-4 py-3">
              <p className="text-xs text-board-muted">{state.lyrics.nextLabel ? `NEXT · ${state.lyrics.nextLabel}` : "END OF SONG"}</p>
              <LyricsControls enabled={connected && control === "yours"} pending={timecode.lyricsPending} error={timecode.lyricsError} onChange={timecode.controlLyrics} keyboard />
              {control !== "yours" && <p className="text-xs text-board-muted">Take timecode control above to change lyrics.</p>}
            </div>
          </section>
        ) : null}
        <MediaLibrary key={orgId} orgId={orgId} />
      </div>
      {songLoaderOpen ? (
        <SongCueLoader orgId={orgId} connected={connected} running={Boolean(state?.running) || generatorPending !== null} defaultTarget={lyricsTarget(settings["lyrics-output"])} format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }} onClose={() => setSongLoaderOpen(false)} onLoad={async (loaded) => { const sourceKey = loaded[0]?.sourceKey; if (!sourceKey) throw new Error("No mapped song cues to load."); await replaceEventGroup(sourceKey, loaded); }} />
      ) : null}
      <Dialog open={editing !== null} onOpenChange={open => { if (!open && !editSaving) setEditing(null); }}>
        <DialogContent showCloseButton={false} className="max-h-[90dvh] max-w-2xl overflow-y-auto border-board-border bg-board-bg text-board-text">
          <DialogTitle>Edit cue</DialogTitle>
          <DialogDescription>Update this cue without deleting it. Its enable state and execution history are preserved. Use Re-arm to make a completed cue available again.</DialogDescription>
          {editing && <>
            {editChanged && <div role="status" className="space-y-2 text-sm text-amber-200">
              <p>{currentEdit ? "This cue or the frame rate changed. Your draft is kept here; reload and review the latest cue before saving." : "This cue was removed from the selected show. Your draft is kept here."}</p>
              {currentEdit && state && <Button variant="outline" disabled={editSaving} onClick={() => setEditing({ ...editing, event: structuredClone(currentEdit), format: { ...state.format }, generation: editing.generation + 1 })}>Reload latest cue</Button>}
            </div>}
            <AutomationEventEditor key={`${editing.event.id}:${editing.generation}`} editing={editing.event} orgId={orgId} format={editing.format}
              connected={connected} loadTargets={loadTargets}
              blockedReason={editChanged ? "Review the changed cue above before saving." : control === "other" ? "Take timecode control before saving." : currentEdit?.executionStatus === "dispatching" ? "Wait for the cue acknowledgement before editing." : undefined}
              onAdd={async draft => {
                if (editing.showId !== timecode.showId) throw new Error("The selected show changed. Return to the original show to review this draft.");
                setEditSaving(true);
                try {
                  await timecode.updateEvent(editing.event, { label: draft.label, triggerTimecode: draft.triggerTimecode, toleranceFrames: draft.toleranceFrames, leadMs: draft.leadMs, payload: draft.payload }, editing.format);
                  setEditing(null);
                } finally { setEditSaving(false); }
              }} />
          </>}
          <Button variant="outline" disabled={editSaving} onClick={() => setEditing(null)}>Cancel editing</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
