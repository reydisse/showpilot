import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { getSong, listSongs } from "@/lib/songs";
import { buildSongAutomationEvents, readSongCueFormat } from "@/lib/song-cues";
import type { TimecodeFormat } from "@/types/timecode";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export function SongCueLoader({ orgId, format, defaultTarget, connected, running, onClose, onLoad }: {
  orgId: string;
  format: TimecodeFormat;
  defaultTarget: "native" | "propresenter" | "both";
  connected: boolean;
  running: boolean;
  onClose: () => void;
  onLoad: (events: ReturnType<typeof buildSongAutomationEvents>) => Promise<void>;
}) {
  const [songs, setSongs] = useState<Awaited<ReturnType<typeof listSongs>>>([]);
  const [song, setSong] = useState<Awaited<ReturnType<typeof getSong>> | null>(null);
  const [songId, setSongId] = useState("");
  const [mapId, setMapId] = useState("");
  const [target, setTarget] = useState(defaultTarget);
  const [offset, setOffset] = useState("0");
  const [clearAfter, setClearAfter] = useState(false);
  const [holdFrames, setHoldFrames] = useState(String(Math.round(format.frameRate) * 5));
  const [loading, setLoading] = useState(true);
  const [loadingSong, setLoadingSong] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectionRef = useRef(0);
  useEffect(() => {
    let active = true;
    void listSongs({ data: { orgId } }).then((items) => { if (active) setSongs(items); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Songs could not load."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; selectionRef.current += 1; };
  }, [orgId]);
  const map = song?.cueMaps.find((candidate) => candidate.id === mapId);
  const parsedFormat = map ? readSongCueFormat(map.format, format) : null;
  const offsetFrames = Number(offset);
  const validOffset = offset.trim() !== "" && Number.isSafeInteger(offsetFrames) && offsetFrames >= 0;
  const clearAfterFrames = Number(holdFrames);
  const validHold = !clearAfter || (holdFrames.trim() !== "" && Number.isSafeInteger(clearAfterFrames) && clearAfterFrames >= 0);
  const blocked = !connected ? "Reconnect before loading song cues." : running ? "Stop the clock before loading song cues." : null;
  const missingMapping = target !== "native" && song && !song.ppPresentationUuid;

  async function selectSong(id: string) {
    const selection = ++selectionRef.current;
    setSongId(id); setSong(null); setMapId(""); setError(""); setLoadingSong(Boolean(id));
    if (!id) return;
    try {
      const next = await getSong({ data: { orgId, songId: id } });
      if (selection !== selectionRef.current) return;
      setSong(next); setMapId(next.cueMaps[0]?.id ?? "");
    } catch (cause) {
      if (selection === selectionRef.current) setError(cause instanceof Error ? cause.message : "Song could not load.");
    } finally { if (selection === selectionRef.current) setLoadingSong(false); }
  }
  async function load() {
    if (blocked || saving || !song || !map || !parsedFormat || "error" in parsedFormat || !validOffset || !validHold || missingMapping) return;
    const selection = selectionRef.current;
    setSaving(true); setError("");
    try {
      const events = buildSongAutomationEvents({ song, cues: map.cues, format: parsedFormat.format, target, offsetFrames, ppPresentationUuid: song.ppPresentationUuid, cueMapId: map.id, clearAfterFrames: clearAfter ? clearAfterFrames : null });
      if (events.length === 0) throw new Error("This cue map has no mapped cues for the selected output.");
      await onLoad(events);
      if (selection === selectionRef.current) onClose();
    } catch (cause) {
      if (selection === selectionRef.current) setError(cause instanceof Error ? cause.message : "Cue load was not confirmed. Your selection has been kept.");
    } finally { if (selection === selectionRef.current) setSaving(false); }
  }
  const inputClass = "mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-h-[90dvh] max-w-lg overflow-y-auto border-board-border bg-board-card p-5 text-board-text">
        <div className="flex items-start justify-between"><div><DialogTitle className="font-semibold text-board-text">Load song cues</DialogTitle><DialogDescription className="mt-1 text-xs text-board-muted">Load one cue map into the stopped timeline. Loading the same map again replaces its existing events.</DialogDescription></div><DialogClose asChild><button aria-label="Close song cue loader" className="min-h-11 min-w-11 p-2 text-board-muted"><X className="h-4 w-4" /></button></DialogClose></div>
        {blocked && <p role="status" className="text-sm text-amber-200">{blocked}</p>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <fieldset disabled={Boolean(blocked) || saving} className="mt-5 grid min-w-0 gap-4 disabled:opacity-60">
          <label className="text-xs text-board-muted">Song
            <select autoFocus disabled={loading} value={songId} onChange={(event) => { void selectSong(event.target.value); }} className={inputClass}>
              <option value="">{loading ? "Loading…" : "Choose a song"}</option>
              {songs.map((item) => <option key={item.id} value={item.id}>{item.title}{item.artist ? ` · ${item.artist}` : ""}</option>)}
            </select>
          </label>
          {song && !loadingSong && song.cueMaps.length === 0 && <p role="status" className="text-sm text-board-muted">This song has no cue maps yet. Open Songs, choose this song, and create a cue map before loading it here.</p>}
          {map?.cues.length === 0 && <p role="status" className="text-sm text-board-muted">This cue map is empty. Add section timings in Songs before loading it.</p>}
          <label className="text-xs text-board-muted">Cue map
            <select disabled={!song || loadingSong} value={mapId} onChange={(event) => setMapId(event.target.value)} className={inputClass}>
              <option value="">{loadingSong ? "Loading cue maps…" : "Choose a cue map"}</option>
              {song?.cueMaps.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.cues.length} cues</option>)}
            </select>
          </label>
          {parsedFormat && "error" in parsedFormat && <p role="alert" className="text-xs text-amber-200">{parsedFormat.error}</p>}
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-board-muted">Output<select value={target} onChange={(event) => { const value = event.target.value; if (value === "native" || value === "propresenter" || value === "both") setTarget(value); }} className={inputClass}><option value="native">Native display</option><option value="propresenter">ProPresenter</option><option value="both">Both</option></select></label>
            <label className="text-xs text-board-muted">Offset frames<input type="number" min="0" step="1" required value={offset} onChange={(event) => setOffset(event.target.value)} className={inputClass} /></label>
          </div>
          {!validOffset && <p role="alert" className="text-xs text-amber-200">Offset must be a whole number of frames, zero or greater.</p>}
          <label className="flex min-h-11 items-center gap-3 text-sm text-board-text"><input type="checkbox" checked={clearAfter} onChange={event => setClearAfter(event.target.checked)} />Clear after last cue</label>
          {clearAfter && <div className="space-y-2">
            <label className="text-xs text-board-muted">Hold after last cue (frames)<input type="number" min="0" step="1" value={holdFrames} onChange={event => setHoldFrames(event.target.value)} className={inputClass} /></label>
            <p className="text-xs text-board-muted">Adds a timed clear after the last section. The native clear applies only to this song load; a later manual override stays visible.</p>
            {target !== "native" && <p className="text-xs text-amber-200">ProPresenter will also clear its current slide at that time.</p>}
          </div>}
          {!validHold && <p role="alert" className="text-xs text-amber-200">Hold must be a whole number of frames, zero or greater.</p>}
          {missingMapping && <p className="text-xs text-amber-200">This song has no ProPresenter presentation mapping. Choose Native display or import its presentation first.</p>}
          <button disabled={!song || !map || map.cues.length === 0 || !parsedFormat || "error" in parsedFormat || !validOffset || !validHold || Boolean(missingMapping)} onClick={() => { void load(); }} className="min-h-11 rounded-xl bg-fire-500 p-3 text-sm font-bold text-black disabled:opacity-40">{saving ? "Waiting for relay…" : `Load ${map?.cues.length ?? 0} mapped cues`}</button>
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
