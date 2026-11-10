import { NamedTimers } from "@/components/timers/NamedTimers";
import { getBlackoutTargets } from "@/lib/automation-targets";
import { getRundownState } from "@/lib/rundown";
import type { AutomationTargetKind } from "@/components/timecode/AutomationTargetPicker";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { useCallback, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FileDown, Music2 } from "lucide-react";
import { useShowTimecode, TimecodeShowPicker, TimecodeControlNotice } from "@/components/timecode/TimecodeContext";
import { TimecodeAutomationControl } from "@/components/timecode/TimecodeAutomationControl";
import { MidiControllerPanel } from "@/components/timecode/MidiController";
import { TimecodeDisplay } from "@/components/timecode/TimecodeDisplay";
import { TimecodeSourceSelector } from "@/components/timecode/TimecodeSourceSelector";
import { AutomationTimeline } from "@/components/timecode/AutomationTimeline";
import { AutomationEventEditor } from "@/components/timecode/AutomationEventEditor";
import { createBrowserId } from "@/lib/browser-id";
import { timecodeToFrames } from "@/lib/timecode";
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

  const timecode = useShowTimecode();
  const {
    state,
    connected,
    control,
    events,
    isMaster,
    generatorPending,
    lastError,
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
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              SMPTE Timecode
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Show automation sequencer
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button disabled={!connected || state?.running || generatorPending !== null} onClick={() => setSongLoaderOpen(true)} className="flex min-h-11 items-center gap-1.5 rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-text hover:border-fire-500/30"><Music2 className="h-3.5 w-3.5 shrink-0" />Load song cues</button>
            <TimecodeDisplay state={state} connected={connected} size="compact" />
          </div>
        </div>
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <TimecodeShowPicker />
        <TimecodeControlNotice />
        {!connected && <p role="status" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">Timecode disconnected. Controls will be available after reconnecting.</p>}
        {lastError && <p role="alert" className="rounded-xl border border-red-500/40 p-4 text-sm text-red-300">{lastError}</p>}
        <TimecodeAutomationControl state={state} connected={connected} canControl={control !== "other"} onSetEnabled={setTriggersEnabled} onResumeAutomaticCues={resumeAutomaticCues} />
        <NamedTimers sample={state?.namedTimers ?? null} connected={connected} outputTarget={timecode.showId ? { orgSlug: slug, showId: timecode.showId } : undefined} />
        {/* Large TC display */}
        <div className="rounded-xl border border-board-border bg-board-card p-4 sm:p-8">
          <TimecodeDisplay state={state} connected={connected} size="large" />
        </div>

        {/* Large TC display */}
        <TimecodeSourceSelector
          showId={timecode.showId}
          isMaster={isMaster}
          connected={connected && control !== "other"}
          pending={generatorPending}
          running={state?.running ?? false}
          totalFrames={state?.totalFrames ?? 0}
          signal={state?.signal}
          source={state?.source}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
          incomingFormat={state?.incomingFormat}
          mtcSupported={mtcSupported}
          onStartFreerun={startFreerun}
          onStopGenerator={stopGenerator}
          onPauseGenerator={pauseGenerator}
          onStartMtc={startMtc}
          onSetFormat={setFormat}
        />

        {/* Large TC display */}
        <MidiControllerPanel key={timecode.showId} timecode={timecode} />
        <AutomationTimeline
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
          loadTargets={loadTargets}
          timerNames={[...new Set([...events.filter(event => event.action === "timer-start").flatMap(event => typeof event.payload.name === "string" ? [event.payload.name] : []), ...(state?.namedTimers?.timers.map(timer => timer.name) ?? [])])]}
          onAdd={addEvent}
          connected={connected && control !== "other"}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
        />

        {state?.lyrics ? (
          <div className="overflow-hidden rounded-xl border border-board-border bg-black"><div className="border-b border-white/10 px-4 py-3"><p className="text-xs font-semibold text-white">{state.lyrics.songTitle}</p><p className="text-[10px] uppercase tracking-wider text-amber-400">{state.lyrics.sectionLabel}</p></div><div className="flex min-h-48 items-center justify-center p-6 text-center"><p className="whitespace-pre-line text-2xl font-semibold leading-tight text-white">{state.lyrics.lyrics}</p></div><p className="border-t border-white/10 px-4 py-3 text-[10px] text-white/40">{state.lyrics.nextLabel ? `NEXT · ${state.lyrics.nextLabel}` : "END OF SONG"}</p></div>
        ) : null}
      </div>
      {songLoaderOpen ? (
        <SongCueLoader orgId={orgId} connected={connected} running={Boolean(state?.running) || generatorPending !== null} defaultTarget={lyricsTarget(settings["lyrics-output"])} format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }} onClose={() => setSongLoaderOpen(false)} onLoad={async (loaded) => { const sourceKey = loaded[0]?.sourceKey; if (!sourceKey) throw new Error("No mapped song cues to load."); await replaceEventGroup(sourceKey, loaded); }} />
      ) : null}
    </div>
  );
}
