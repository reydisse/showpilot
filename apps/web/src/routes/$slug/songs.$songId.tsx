import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, GripVertical, MonitorPlay, Plus, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { buildSongAutomationEvents, formatCueFrame } from "@/lib/song-cues";
import { deleteSongSection, getSong, importProPresenterSong, listProPresenterSongs, reorderSongSections, saveSongCueMap, saveSongMetadata, saveSongSection } from "@/lib/songs";
import { useTimecode } from "@/hooks/useTimecode";
import type { FrameRate, TimecodeFormat } from "@/types/timecode";
import { parseTimecodeString, timecodeToFrames } from "@/lib/timecode";
import { getOrgSettings } from "@/lib/settings";

export const Route = createFileRoute("/$slug/songs/$songId")({
  loader: async ({ context, params }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "songs:access", context.slug, context.orgId);
    const [song, settings] = await Promise.all([getSong({ data: { orgId: context.orgId, songId: params.songId } }), getOrgSettings({ data: { orgId: context.orgId } })]);
    return { orgId: context.orgId, slug: context.slug, role: context.role, grantedPermissions: context.grantedPermissions, song, settings };
  },
  component: SongStudioPage,
});

type CueDraft = { sectionId: string; triggerTc: string; ppSlideIndex: number | null };

function parseFormat(value: string): TimecodeFormat {
  try {
    const parsed = JSON.parse(value) as Partial<TimecodeFormat>;
    if ([24, 25, 29.97, 30].includes(parsed.frameRate as number) && (parsed.dropFrame === "df" || parsed.dropFrame === "ndf")) return parsed as TimecodeFormat;
  } catch {}
  return { frameRate: 30, dropFrame: "ndf" };
}

function lyricsTarget(value: string | undefined): "native" | "propresenter" | "both" {
  return value === "native" || value === "propresenter" ? value : "both";
}

function SongStudioPage() {
  const { orgId, slug, role, grantedPermissions, song, settings } = Route.useLoaderData();
  const router = useRouter();
  const canManage = hasEffectivePermission(role, grantedPermissions, "songs:manage");
  const timecode = useTimecode({ orgId, enabled: true });
  const [metadata, setMetadata] = useState({ title: song.title, artist: song.artist, ccliNumber: song.ccliNumber, bpm: song.bpm ? String(song.bpm) : "", keySignature: song.keySignature });
  const [sections, setSections] = useState(song.sections);
  const [mapId, setMapId] = useState(song.cueMaps[0]?.id ?? "");
  const selectedMap = song.cueMaps.find((map) => map.id === mapId);
  const [mapName, setMapName] = useState(selectedMap?.name ?? "Default");
  const [format, setFormat] = useState<TimecodeFormat>(() => selectedMap ? parseFormat(selectedMap.format) : { frameRate: 30, dropFrame: "ndf" });
  const [cues, setCues] = useState<CueDraft[]>(() => selectedMap?.cues.map((cue) => ({ sectionId: cue.sectionId, triggerTc: cue.triggerTc, ppSlideIndex: cue.ppSlideIndex })) ?? []);
  const [target, setTarget] = useState<"native" | "propresenter" | "both">(() => lyricsTarget(settings["lyrics-output"]));
  const [offsetFrames, setOffsetFrames] = useState(0);
  const [tapIndex, setTapIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);

  const refresh = async () => { await router.invalidate(); };
  useEffect(() => {
    setMetadata({ title: song.title, artist: song.artist, ccliNumber: song.ccliNumber, bpm: song.bpm ? String(song.bpm) : "", keySignature: song.keySignature });
    setSections(song.sections);
    const nextMap = song.cueMaps.find((candidate) => candidate.id === mapId) ?? song.cueMaps[0];
    setMapId(nextMap?.id ?? "");
    setMapName(nextMap?.name ?? "Default");
    setFormat(nextMap ? parseFormat(nextMap.format) : { frameRate: 30, dropFrame: "ndf" });
    setCues(nextMap?.cues.map((cue) => ({ sectionId: cue.sectionId, triggerTc: cue.triggerTc, ppSlideIndex: cue.ppSlideIndex })) ?? []);
  }, [song]);
  const chooseMap = (id: string) => {
    setMapId(id);
    const map = song.cueMaps.find((candidate) => candidate.id === id);
    setMapName(map?.name ?? "New map");
    setFormat(map ? parseFormat(map.format) : { frameRate: 30, dropFrame: "ndf" });
    setCues(map?.cues.map((cue) => ({ sectionId: cue.sectionId, triggerTc: cue.triggerTc, ppSlideIndex: cue.ppSlideIndex })) ?? []);
  };
  const captureNext = () => {
    if (tapIndex === null || !timecode.state || sections.length === 0) return;
    const section = sections[tapIndex % sections.length];
    setCues((current) => [...current, { sectionId: section.id, triggerTc: timecode.display, ppSlideIndex: section.sourceSlideIndex }]);
    setTapIndex((current) => current === null ? null : current + 1);
  };
  useEffect(() => {
    if (tapIndex === null) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      event.preventDefault(); captureNext();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  const saveMap = async (): Promise<string | null> => {
    setBusy(true); setNotice(null);
    try {
      const result = await saveSongCueMap({ data: { orgId, songId: song.id, cueMapId: mapId || undefined, name: mapName, frameRate: format.frameRate, dropFrame: format.dropFrame, cues } });
      setMapId(result.cueMapId); setNotice("Cue map saved."); await refresh(); return result.cueMapId;
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Cue map did not save."); return null; } finally { setBusy(false); }
  };
  const loadCues = async () => {
    const savedMapId = await saveMap();
    if (!savedMapId) return;
    const current = await getSong({ data: { orgId, songId: song.id } });
    const map = current.cueMaps.find((candidate) => candidate.id === savedMapId);
    if (!map) return;
    const events = buildSongAutomationEvents({ song: current, cues: map.cues, format: parseFormat(map.format), target, offsetFrames, ppPresentationUuid: current.ppPresentationUuid });
    events.forEach(({ id: _id, fired: _fired, triggerFrame: _triggerFrame, ...event }) => timecode.addEvent(event));
    setNotice(`${events.length} lyric automation events loaded into Timecode.`);
  };
  const nudgeCue = (index: number, delta: number) => {
    const parsed = parseTimecodeString(cues[index]?.triggerTc ?? "");
    if (!parsed) return;
    const frame = Math.max(0, timecodeToFrames(parsed, format) + delta);
    setCues((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, triggerTc: formatCueFrame(frame, format) } : item));
  };
  const moveSection = async (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= sections.length || to >= sections.length) return;
    const next = [...sections];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setSections(next);
    await reorderSongSections({ data: { orgId, songId: song.id, sectionIds: next.map((item) => item.id) } });
  };
  const reimport = async () => {
    if (!song.ppPresentationUuid) return;
    setBusy(true); setNotice(null);
    try {
      const result = await listProPresenterSongs({ data: { orgId } });
      if (!result.connected) throw new Error("Venue Bridge or ProPresenter is offline. Connect it, then try again.");
      const presentation = result.presentations.find((candidate) => candidate.uuid === song.ppPresentationUuid);
      if (!presentation) throw new Error("This presentation is no longer available in ProPresenter.");
      await importProPresenterSong({ data: { orgId, presentation, strategy: "merge" } });
      await refresh();
      setNotice("Updated from ProPresenter. Existing section IDs and cue maps were preserved.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "ProPresenter update failed."); } finally { setBusy(false); }
  };

  return <div className="min-h-full bg-board-bg p-4 sm:p-6"><div className="mx-auto max-w-7xl space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><Link to="/$slug/songs" params={{ slug }} aria-label="Back to songs" className="rounded-xl border border-board-border bg-board-card p-2.5 text-board-muted"><ArrowLeft className="h-4 w-4" /></Link><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-fire-500">Song studio</p><h1 className="truncate text-xl font-semibold text-board-text">{metadata.title}</h1></div></div><div className="flex items-center gap-2">{song.ppPresentationUuid && canManage ? <button disabled={busy} onClick={() => void reimport()} className="inline-flex items-center gap-1.5 rounded-lg border border-board-border bg-board-card px-3 py-2 text-xs font-semibold text-board-text disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5" />Check ProPresenter</button> : null}<div className="flex items-center gap-2 text-xs text-board-muted"><span className={`h-2 w-2 rounded-full ${timecode.connected ? "bg-green-400" : "bg-red-400"}`} />{timecode.connected ? timecode.display : "Timecode offline"}</div></div></header>
    {notice ? <p role="status" className="rounded-xl border border-board-border bg-board-card px-4 py-3 text-sm text-board-muted">{notice}</p> : null}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,.8fr)]">
      <main className="space-y-5">
        <section className="rounded-2xl border border-board-border bg-board-card p-5"><div className="grid gap-3 sm:grid-cols-2"><Field label="Title" value={metadata.title} onChange={(title) => setMetadata({ ...metadata, title })} /><Field label="Artist" value={metadata.artist} onChange={(artist) => setMetadata({ ...metadata, artist })} /><Field label="CCLI number" value={metadata.ccliNumber} onChange={(ccliNumber) => setMetadata({ ...metadata, ccliNumber })} /><div className="grid grid-cols-2 gap-3"><Field label="BPM" value={metadata.bpm} onChange={(bpm) => setMetadata({ ...metadata, bpm })} /><Field label="Key" value={metadata.keySignature} onChange={(keySignature) => setMetadata({ ...metadata, keySignature })} /></div></div>{canManage ? <button type="button" onClick={() => void saveSongMetadata({ data: { orgId, songId: song.id, title: metadata.title, artist: metadata.artist, ccliNumber: metadata.ccliNumber, bpm: metadata.bpm ? Number(metadata.bpm) : null, keySignature: metadata.keySignature } }).then(refresh)} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-bold text-black"><Save className="h-4 w-4" />Save song details</button> : null}</section>
        <section className="rounded-2xl border border-board-border bg-board-card p-5"><div className="flex items-center justify-between"><div><h2 className="font-semibold text-board-text">Arrangement</h2><p className="mt-1 text-xs text-board-muted">Drag sections into show order. Cue maps can repeat any section.</p></div>{canManage ? <button type="button" onClick={async () => { await saveSongSection({ data: { orgId, songId: song.id, label: `Section ${sections.length + 1}`, lyrics: "", sourceSlideIndex: null } }); await refresh(); }} className="inline-flex items-center gap-2 rounded-lg border border-board-border px-3 py-2 text-xs font-semibold text-board-text"><Plus className="h-3.5 w-3.5" />Section</button> : null}</div><div className="mt-4 space-y-3">{sections.map((section, index) => <div key={section.id} draggable={canManage} onDragStart={() => setDraggedSectionId(section.id)} onDragEnd={() => setDraggedSectionId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => { const from = sections.findIndex((item) => item.id === draggedSectionId); setDraggedSectionId(null); void moveSection(from, index); }} className={`rounded-xl border bg-board-bg p-3 ${draggedSectionId === section.id ? "border-fire-500/60 opacity-60" : "border-board-border"}`}><div className="flex gap-2">{canManage ? <span aria-hidden="true" className="cursor-grab p-2 text-board-muted"><GripVertical className="h-4 w-4" /></span> : null}<input value={section.label} onChange={(event) => setSections((current) => current.map((item) => item.id === section.id ? { ...item, label: event.target.value } : item))} className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-board-text outline-none" /><button aria-label="Move section up" disabled={index === 0} onClick={() => void moveSection(index, index - 1)} className="p-2 text-board-muted disabled:opacity-20"><ChevronUp className="h-4 w-4" /></button><button aria-label="Move section down" disabled={index === sections.length - 1} onClick={() => void moveSection(index, index + 1)} className="p-2 text-board-muted disabled:opacity-20"><ChevronDown className="h-4 w-4" /></button></div><textarea value={section.lyrics} onChange={(event) => setSections((current) => current.map((item) => item.id === section.id ? { ...item, lyrics: event.target.value } : item))} rows={4} placeholder="Lyrics, up to four display lines per section" className="mt-2 w-full resize-y rounded-lg border border-board-border bg-board-card p-3 text-sm leading-6 text-board-text outline-none" />{canManage ? <div className="mt-2 flex justify-between"><button onClick={() => timecode.setLyrics({ songId: song.id, songTitle: metadata.title, sectionId: section.id, sectionLabel: section.label, lyrics: section.lyrics, nextLabel: sections[index + 1]?.label ?? "" })} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-300"><MonitorPlay className="h-3.5 w-3.5" />Show now</button><div className="flex gap-2"><button onClick={() => void saveSongSection({ data: { orgId, songId: song.id, sectionId: section.id, label: section.label, lyrics: section.lyrics, sourceSlideIndex: section.sourceSlideIndex } }).then(refresh)} className="text-xs font-semibold text-fire-500">Save section</button><button aria-label={`Delete ${section.label}`} onClick={() => { const mapped = song.cueMaps.some((map) => map.cues.some((cue) => cue.sectionId === section.id)); if (mapped && !window.confirm(`Delete ${section.label}? This will also remove its mapped cues.`)) return; void deleteSongSection({ data: { orgId, songId: song.id, sectionId: section.id, confirmMapped: mapped } }).then(refresh).catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : "Section did not delete.")); }} className="text-red-400"><Trash2 className="h-3.5 w-3.5" /></button></div></div> : null}</div>)}</div></section>
      </main>
      <aside className="space-y-5">
        <LyricsPreview title={timecode.state?.lyrics?.songTitle ?? metadata.title} section={timecode.state?.lyrics?.sectionLabel ?? "Preview"} lyrics={timecode.state?.lyrics?.lyrics ?? sections[0]?.lyrics ?? "Lyrics will appear here"} next={timecode.state?.lyrics?.nextLabel ?? sections[1]?.label ?? ""} timecode={timecode.display} onClear={timecode.clearLyrics} />
        <section className="rounded-2xl border border-board-border bg-board-card p-5"><div className="flex flex-wrap items-end gap-3"><label className="min-w-40 flex-1 text-xs text-board-muted">Cue map<select value={mapId} onChange={(event) => chooseMap(event.target.value)} className="mt-2 w-full rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"><option value="">New cue map</option>{song.cueMaps.map((map) => <option key={map.id} value={map.id}>{map.name}</option>)}</select></label><Field label="Map name" value={mapName} onChange={setMapName} /></div><div className="mt-3 grid grid-cols-3 gap-2"><label className="text-xs text-board-muted">FPS<select value={format.frameRate} onChange={(event) => setFormat({ frameRate: Number(event.target.value) as FrameRate, dropFrame: Number(event.target.value) === 29.97 ? format.dropFrame : "ndf" })} className="mt-1 w-full rounded-lg border border-board-border bg-board-bg p-2 text-board-text"><option>24</option><option>25</option><option>29.97</option><option>30</option></select></label><label className="text-xs text-board-muted">Mode<select value={format.dropFrame} onChange={(event) => setFormat({ ...format, dropFrame: event.target.value as "df" | "ndf" })} className="mt-1 w-full rounded-lg border border-board-border bg-board-bg p-2 text-board-text"><option value="ndf">NDF</option>{format.frameRate === 29.97 ? <option value="df">DF</option> : null}</select></label><label className="text-xs text-board-muted">Offset<input type="number" value={offsetFrames} onChange={(event) => setOffsetFrames(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-board-border bg-board-bg p-2 text-board-text" /></label></div><div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-board-muted"><span>Quick offset</span>{[-5, -2, -1, 0, 1, 2, 5].map((value) => <button key={value} onClick={() => setOffsetFrames(value)} className={`rounded-md border px-2 py-1 ${offsetFrames === value ? "border-fire-500/50 bg-fire-500/10 text-fire-300" : "border-board-border"}`}>{value > 0 ? `+${value}` : value}f</button>)}</div><div className="mt-4 space-y-2">{cues.map((cue, index) => <div key={`${index}-${cue.sectionId}`} className="grid grid-cols-[1fr_8rem_auto] gap-2"><select aria-label={`Cue ${index + 1} section`} value={cue.sectionId} onChange={(event) => setCues((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, sectionId: event.target.value } : item))} className="min-w-0 rounded-lg border border-board-border bg-board-bg p-2 text-xs text-board-text">{sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}</select><div className="flex"><button aria-label="Nudge cue back one frame" onClick={() => nudgeCue(index, -1)} className="border border-board-border px-2 text-board-muted">−</button><input aria-label={`Cue ${index + 1} timecode`} value={cue.triggerTc} onChange={(event) => setCues((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, triggerTc: event.target.value } : item))} className="min-w-0 flex-1 border-y border-board-border bg-board-bg px-1 text-center font-mono text-[10px] text-board-text" /><button aria-label="Nudge cue forward one frame" onClick={() => nudgeCue(index, 1)} className="border border-board-border px-2 text-board-muted">+</button></div><button aria-label="Remove cue" onClick={() => setCues((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="p-2 text-red-400"><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div><div className="mt-3 flex flex-wrap gap-2"><button disabled={!sections.length} onClick={() => setCues((current) => [...current, { sectionId: sections[0].id, triggerTc: timecode.display, ppSlideIndex: sections[0].sourceSlideIndex }])} className="rounded-lg border border-board-border px-3 py-2 text-xs font-semibold text-board-text"><Plus className="mr-1 inline h-3.5 w-3.5" />Cue</button><button onClick={() => setTapIndex(tapIndex === null ? 0 : null)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${tapIndex === null ? "border border-board-border text-board-text" : "bg-red-500 text-white"}`}>{tapIndex === null ? "Tap-to-mark" : `Mark ${sections[tapIndex % Math.max(1, sections.length)]?.label ?? "next"} · Space`}</button>{tapIndex !== null ? <button onClick={captureNext} className="rounded-lg bg-fire-500 px-3 py-2 text-xs font-bold text-black">Mark {timecode.display}</button> : null}</div><div className="mt-4 grid grid-cols-[1fr_auto] gap-2"><select value={target} onChange={(event) => setTarget(event.target.value as typeof target)} className="rounded-xl border border-board-border bg-board-bg p-2.5 text-sm text-board-text"><option value="native">Native display</option><option value="propresenter">ProPresenter</option><option value="both">Both outputs</option></select><button disabled={busy || !cues.length} onClick={() => void loadCues()} className="inline-flex items-center gap-2 rounded-xl bg-fire-500 px-4 text-sm font-bold text-black disabled:opacity-40"><Upload className="h-4 w-4" />Load cues</button></div><button disabled={busy} onClick={() => void saveMap()} className="mt-2 w-full rounded-xl border border-board-border p-2.5 text-sm font-semibold text-board-text">{busy ? "Saving…" : "Save cue map"}</button></section>
      </aside>
    </div>
  </div></div>;
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <label className="min-w-0 flex-1 text-xs text-board-muted">{label}<input value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text outline-none" /></label>; }

function LyricsPreview({ title, section, lyrics, next, timecode, onClear }: { title: string; section: string; lyrics: string; next: string; timecode: string; onClear: () => void }) { return <section className="overflow-hidden rounded-2xl border border-board-border bg-black shadow-2xl"><div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div><p className="text-xs font-semibold text-white">{title}</p><p className="text-[10px] uppercase tracking-wider text-amber-400">{section}</p></div><span className="font-mono text-[10px] text-white/40">{timecode}</span></div><div className="flex min-h-64 items-center justify-center p-7 text-center"><p className="whitespace-pre-line text-balance text-2xl font-semibold leading-tight text-white">{lyrics}</p></div><div className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-[10px] text-white/40"><span>{next ? `Next · ${next}` : "End of song"}</span><button onClick={onClear} className="text-white/60">Clear output</button></div></section>; }
