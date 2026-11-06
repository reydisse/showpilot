import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FileDown, Music2 } from "lucide-react";
import { useShowTimecode, TimecodeShowPicker } from "@/components/timecode/TimecodeContext";
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
  const { orgId } = Route.useRouteContext() as { orgId: string };
  const { settings } = Route.useLoaderData();

  const {
    state,
    connected,
    events,
    isMaster,
    generatorPending,
    lastError,
    startFreerun,
    stopGenerator,
    startMtc,
    setFormat,
    addEvent,
    replaceEventGroup,
    removeEvent,
    resetEvents,
    retryEvent,
    setEventEnabled,
    setTriggersEnabled,
    mtcSupported,
  } = useShowTimecode();

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
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              SMPTE Timecode
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Show automation sequencer
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button disabled={!connected || state?.running || generatorPending !== null} onClick={() => setSongLoaderOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-text hover:border-fire-500/30"><Music2 className="h-3.5 w-3.5" />Load song cues</button>
            <TimecodeDisplay state={state} connected={connected} size="compact" />
          </div>
        </div>
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <TimecodeShowPicker />
        {!connected && <p role="status" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">Timecode disconnected. Controls will be available after reconnecting.</p>}
        {lastError && <p role="alert" className="rounded-xl border border-red-500/40 p-4 text-sm text-red-300">{lastError}</p>}
        <button
          type="button"
          disabled={!connected || !state}
          aria-pressed={state?.triggersEnabled ?? true}
          onClick={() => setTriggersEnabled(!state?.triggersEnabled)}
          className="min-h-11 rounded-xl border border-amber-500/40 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50"
        >
          {state?.triggersEnabled === false ? "Enable automation" : "Disable automation"}
        </button>
        {state?.triggersEnabled === false && <p role="status" className="text-sm text-amber-200">Automation disabled. The clock and displays keep running. Missed cues will not replay automatically.</p>}
        {/* Large TC display */}
        <div className="rounded-xl border border-board-border bg-board-card p-8">
          <TimecodeDisplay state={state} connected={connected} size="large" />
        </div>

        {/* Large TC display */}
        <TimecodeSourceSelector
          isMaster={isMaster}
          connected={connected}
          pending={generatorPending}
          running={state?.running ?? false}
          totalFrames={state?.totalFrames ?? 0}
          signal={state?.signal}
          source={state?.source}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
          mtcSupported={mtcSupported}
          onStartFreerun={startFreerun}
          onStopGenerator={stopGenerator}
          onStartMtc={startMtc}
          onSetFormat={setFormat}
        />

        {/* Large TC display */}
        <AutomationTimeline
          events={events}
          state={state}
          onRemoveEvent={removeEvent}
          onResetEvents={resetEvents}
          onRetryEvent={retryEvent}
          onSetEventEnabled={setEventEnabled}
          connected={connected}
        />

        {events.length === 0 && !demoLoaded && !state?.running && connected && (
          <section className="rounded-xl border border-board-border p-4 text-sm text-board-muted">
            <p>Try a sample automation timeline in this empty workspace.</p>
            <button type="button" disabled={demoPending} onClick={() => { void loadDemo(); }} className="mt-3 flex min-h-11 items-center gap-2 rounded-lg border border-board-border px-3 text-board-text"><FileDown className="h-4 w-4" />Load Demo Show</button>
          </section>
        )}
        {/* Add event */}
        <AutomationEventEditor
          onAdd={addEvent}
          connected={connected}
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
