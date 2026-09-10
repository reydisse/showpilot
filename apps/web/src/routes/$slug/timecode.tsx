import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FileDown, Music2, X } from "lucide-react";
import { useTimecode } from "@/hooks/useTimecode";
import { TimecodeDisplay } from "@/components/timecode/TimecodeDisplay";
import { TimecodeSourceSelector } from "@/components/timecode/TimecodeSourceSelector";
import { AutomationTimeline } from "@/components/timecode/AutomationTimeline";
import { AutomationEventEditor } from "@/components/timecode/AutomationEventEditor";
import { DEMO_EVENTS } from "@/lib/seed-timecode-demo";
import { getSong, listSongs } from "@/lib/songs";
import { buildSongAutomationEvents } from "@/lib/song-cues";
import type { TimecodeFormat } from "@/types/timecode";
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
  const { orgId } = Route.useRouteContext() as { orgId: string };
  const { settings } = Route.useLoaderData();

  const {
    state,
    connected,
    events,
    isMaster,
    startFreerun,
    stopGenerator,
    startMtc,
    setFormat,
    addEvent,
    removeEvent,
    resetEvents,
    mtcSupported,
  } = useTimecode({ orgId, enabled: true });

  const [demoLoaded, setDemoLoaded] = useState(false);
  const [songLoaderOpen, setSongLoaderOpen] = useState(false);

  function loadDemo() {
    for (const event of DEMO_EVENTS) {
      addEvent(event);
    }
    setDemoLoaded(true);
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
            {events.length === 0 && !demoLoaded && (
              <button
                onClick={loadDemo}
                className="flex items-center gap-1.5 rounded-lg border border-fire-500/20 bg-fire-500/10 px-3 py-1.5 text-xs font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
              >
                <FileDown className="w-3 h-3" />
                Load Demo Show
              </button>
            )}
            <button onClick={() => setSongLoaderOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-text hover:border-fire-500/30"><Music2 className="h-3.5 w-3.5" />Load song cues</button>
            <TimecodeDisplay state={state} connected={connected} size="compact" />
          </div>
        </div>
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Large TC display */}
        <div className="rounded-xl border border-board-border bg-board-card p-8">
          <TimecodeDisplay state={state} connected={connected} size="large" />
        </div>

        {/* Source selector */}
        <TimecodeSourceSelector
          isMaster={isMaster}
          running={state?.running ?? false}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
          mtcSupported={mtcSupported}
          onStartFreerun={startFreerun}
          onStopGenerator={stopGenerator}
          onStartMtc={startMtc}
          onSetFormat={setFormat}
        />

        {/* Automation timeline */}
        <AutomationTimeline
          events={events}
          state={state}
          onRemoveEvent={removeEvent}
          onResetEvents={resetEvents}
        />

        {/* Add event */}
        <AutomationEventEditor
          onAdd={addEvent}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
        />

        {state?.lyrics ? <div className="overflow-hidden rounded-xl border border-board-border bg-black"><div className="border-b border-white/10 px-4 py-3"><p className="text-xs font-semibold text-white">{state.lyrics.songTitle}</p><p className="text-[10px] uppercase tracking-wider text-amber-400">{state.lyrics.sectionLabel}</p></div><div className="flex min-h-48 items-center justify-center p-6 text-center"><p className="whitespace-pre-line text-2xl font-semibold leading-tight text-white">{state.lyrics.lyrics}</p></div><p className="border-t border-white/10 px-4 py-3 text-[10px] text-white/40">{state.lyrics.nextLabel ? `NEXT · ${state.lyrics.nextLabel}` : "END OF SONG"}</p></div> : null}
      </div>
      {songLoaderOpen ? <SongCueLoader orgId={orgId} defaultTarget={lyricsTarget(settings["lyrics-output"])} format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }} onClose={() => setSongLoaderOpen(false)} onLoad={(loaded) => { loaded.forEach(({ id: _id, fired: _fired, triggerFrame: _triggerFrame, ...event }) => addEvent(event)); setSongLoaderOpen(false); }} /> : null}
    </div>
  );
}

function SongCueLoader({ orgId, format, defaultTarget, onClose, onLoad }: { orgId: string; format: TimecodeFormat; defaultTarget: "native" | "propresenter" | "both"; onClose: () => void; onLoad: (events: ReturnType<typeof buildSongAutomationEvents>) => void }) {
  const [songs, setSongs] = useState<Awaited<ReturnType<typeof listSongs>>>([]);
  const [song, setSong] = useState<Awaited<ReturnType<typeof getSong>> | null>(null);
  const [mapId, setMapId] = useState("");
  const [target, setTarget] = useState<"native" | "propresenter" | "both">(defaultTarget);
  const [offsetFrames, setOffsetFrames] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { void listSongs({ data: { orgId } }).then(setSongs).catch((cause) => setError(cause instanceof Error ? cause.message : "Songs could not load.")).finally(() => setLoading(false)); }, [orgId]);
  const map = song?.cueMaps.find((candidate) => candidate.id === mapId);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"><div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-board-border bg-board-card p-5"><div className="flex items-start justify-between"><div><h2 className="font-semibold text-board-text">Load song cues</h2><p className="mt-1 text-xs text-board-muted">Add one shared cue map to the current automation timeline.</p></div><button aria-label="Close song cue loader" onClick={onClose} className="p-2 text-board-muted"><X className="h-4 w-4" /></button></div>{error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}<div className="mt-5 grid gap-4"><label className="text-xs text-board-muted">Song<select disabled={loading} value={song?.id ?? ""} onChange={(event) => { const id = event.target.value; if (!id) return setSong(null); void getSong({ data: { orgId, songId: id } }).then((next) => { setSong(next); setMapId(next.cueMaps[0]?.id ?? ""); }); }} className="mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"><option value="">{loading ? "Loading…" : "Choose a song"}</option>{songs.map((item) => <option key={item.id} value={item.id}>{item.title}{item.artist ? ` · ${item.artist}` : ""}</option>)}</select></label><label className="text-xs text-board-muted">Cue map<select disabled={!song} value={mapId} onChange={(event) => setMapId(event.target.value)} className="mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"><option value="">Choose a cue map</option>{song?.cueMaps.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.cues.length} cues</option>)}</select></label><div className="grid grid-cols-2 gap-3"><label className="text-xs text-board-muted">Output<select value={target} onChange={(event) => setTarget(event.target.value as typeof target)} className="mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"><option value="native">Native display</option><option value="propresenter">ProPresenter</option><option value="both">Both</option></select></label><label className="text-xs text-board-muted">Offset frames<input type="number" value={offsetFrames} onChange={(event) => setOffsetFrames(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text" /></label></div>{target !== "native" && song && !song.ppPresentationUuid ? <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-200">This manual song has no ProPresenter presentation mapping. Choose Native display or import its presentation first.</p> : null}<button disabled={!song || !map || (target !== "native" && !song.ppPresentationUuid)} onClick={() => { if (!song || !map) return; let mapFormat = format; try { mapFormat = JSON.parse(map.format) as TimecodeFormat; } catch {} onLoad(buildSongAutomationEvents({ song, cues: map.cues, format: mapFormat, target, offsetFrames, ppPresentationUuid: song.ppPresentationUuid })); }} className="rounded-xl bg-fire-500 p-3 text-sm font-bold text-black disabled:opacity-40">Load {map?.cues.length ?? 0} mapped cues</button></div></div></div>;
}
