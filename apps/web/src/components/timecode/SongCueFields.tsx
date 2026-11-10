import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { getSong, listSongs } from "@/lib/songs";
import type { CueDetails } from "@/lib/automation-catalog";
import { useCueChoices } from "./useCueChoices";

export type CueSong = Pick<Awaited<ReturnType<typeof getSong>>, "id" | "title" | "ppPresentationUuid" | "sections">;
export type CueSongSummary = Pick<CueSong, "id" | "title" | "ppPresentationUuid">;
const inputClass = "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text";
export function SongCueFields({ orgId, proPresenter, initial, onChange, loadSongs, loadSong }: {
  orgId?: string; proPresenter: boolean; initial: Record<string, unknown>; onChange: (details: CueDetails) => void;
  loadSongs?: () => Promise<CueSongSummary[]>; loadSong?: (id: string) => Promise<CueSong>;
}) {
  const load = useCallback(() => loadSongs ? loadSongs() : orgId ? listSongs({ data: { orgId } }) : Promise.reject(new Error("Select a workspace before choosing a song.")), [loadSongs, orgId]);
  const { choices, retry } = useCueChoices(load);
  const [selected, setSelected] = useState<string | null>(typeof initial.songId === "string" ? initial.songId : null);
  const id = useId();
  const songs = choices.status === "ready" ? choices.value.filter(song => !proPresenter || song.ppPresentationUuid) : [];
  const songId = selected ?? (proPresenter ? songs.find(song => song.ppPresentationUuid === initial.presentationUuid)?.id ?? "" : "");
  const song = songs.find(song => song.id === songId);
  useEffect(() => { if (!song) onChange({ status: "invalid", message: "Choose an available song and section." }); }, [song, onChange]);
  return <div className="space-y-3">
    <div><label htmlFor={id} className="mb-1 block text-xs text-board-muted">{proPresenter ? "ProPresenter song" : "Song"}</label>
      <select id={id} className={inputClass} value={songId} disabled={choices.status !== "ready"} onChange={event => { onChange({ status: "invalid", message: "Choose a section." }); setSelected(event.target.value); }}>
        <option value="">Choose a song</option>{songs.map(song => <option key={song.id} value={song.id}>{song.title}</option>)}
      </select></div>
    {song && <SongSectionFields key={`${orgId}:${song.id}:${proPresenter}`} orgId={orgId} songId={song.id} proPresenter={proPresenter} initial={initial} onChange={onChange} loadSong={loadSong} />}
    {choices.status === "loading" && <p role="status" className="text-xs text-board-muted">Loading songs…</p>}
    {choices.status === "error" && <p role="alert" className="text-xs text-red-300">{choices.message}</p>}
    {choices.status === "ready" && songs.length === 0 && <p className="text-xs text-board-muted">{proPresenter ? "Import a presentation from ProPresenter in Songs first." : "Create a song with sections in Songs first."}</p>}
    <button type="button" disabled={choices.status === "loading"} onClick={() => { onChange({ status: "invalid", message: "Review the refreshed song list." }); retry(); }} className="min-h-11 rounded-lg border border-board-border px-3 text-xs">Refresh songs</button>
  </div>;
}

function SongSectionFields({ orgId, songId, proPresenter, initial, onChange, loadSong }: {
  orgId?: string; songId: string; proPresenter: boolean; initial: Record<string, unknown>; onChange: (details: CueDetails) => void;
  loadSong?: (id: string) => Promise<CueSong>;
}) {
  const load = useCallback(() => loadSong ? loadSong(songId) : orgId ? getSong({ data: { orgId, songId } }) : Promise.reject(new Error("Select a workspace first.")), [loadSong, orgId, songId]);
  const { choices, retry } = useCueChoices(load);
  const [sectionId, setSectionId] = useState<string | null>(initial.songId === songId && typeof initial.sectionId === "string" ? initial.sectionId : null);
  const [target, setTarget] = useState(typeof initial.target === "string" ? initial.target : "");
  const id = useId();
  const song = choices.status === "ready" ? choices.value : null;
  const selectedId = sectionId ?? (proPresenter && song && song.ppPresentationUuid === initial.presentationUuid ? song.sections.find(section => section.sourceSlideIndex === initial.slideIndex)?.id ?? "" : "");
  const section = song?.sections.find(section => section.id === selectedId);
  const details = useMemo<CueDetails>(() => {
    if (!song || !section) return { status: "invalid", message: "Choose a saved section." };
    if (proPresenter) {
      if (!song.ppPresentationUuid || section.sourceSlideIndex === null) return { status: "invalid", message: "This section has no ProPresenter slide. Import or map the presentation in Songs first." };
      return { status: "ready", payload: { presentationUuid: song.ppPresentationUuid, slideIndex: section.sourceSlideIndex, ...(target.trim() ? { target: target.trim() } : {}) } };
    }
    return { status: "ready", payload: { songId: song.id, songTitle: song.title, sectionId: section.id, sectionLabel: section.label, lyrics: section.lyrics, nextLabel: song.sections[song.sections.indexOf(section) + 1]?.label ?? "" } };
  }, [song, section, proPresenter, target]);
  useEffect(() => onChange(details), [details, onChange]);
  return <div className="space-y-3">
    <div><label htmlFor={`${id}-section`} className="mb-1 block text-xs text-board-muted">Section</label>
      <select id={`${id}-section`} className={inputClass} disabled={!song} value={selectedId} onChange={event => setSectionId(event.target.value)}>
        <option value="">Choose a section</option>{song?.sections.map(section => <option key={section.id} value={section.id}>{section.label}</option>)}
      </select></div>
    {section && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-board-border p-3 text-sm">{section.lyrics}</p>}
    {proPresenter && <div><label htmlFor={`${id}-target`} className="mb-1 block text-xs text-board-muted">ProPresenter target (optional)</label>
      <input id={`${id}-target`} className={inputClass} value={target} onChange={event => setTarget(event.target.value)} placeholder="propresenter:192.168.1.20:50001" />
      <p className="text-xs text-board-muted">Leave blank when only one ProPresenter is connected.</p></div>}
    {choices.status === "loading" && <p role="status" className="text-xs text-board-muted">Loading sections…</p>}
    {choices.status === "error" && <p role="alert" className="text-xs text-red-300">{choices.message}</p>}
    {section && details.status === "invalid" && <p role="alert" className="text-xs text-red-300">{details.message}</p>}
    {song?.sections.length === 0 && <p className="text-xs text-board-muted">Add sections to this song first.</p>}
    <button type="button" disabled={choices.status === "loading"} onClick={retry} className="min-h-11 rounded-lg border border-board-border px-3 text-xs">Refresh sections</button>
  </div>;
}
