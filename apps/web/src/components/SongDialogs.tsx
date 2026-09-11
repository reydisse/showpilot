import { useRef, useState } from "react";
import { ClipboardPaste, Plus, Trash2, X } from "lucide-react";
import { formatSongLyrics, insertPastedLyrics } from "@/lib/song-lyrics-format";

export interface NewSongDraft {
  title: string;
  artist: string;
  ccliNumber: string;
  bpm: number | null;
  keySignature: string;
  sections: Array<{ label: string; lyrics: string }>;
}

interface EditableSection {
  key: number;
  label: string;
  lyrics: string;
}

const inputClassName = "mt-2 w-full rounded-xl border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text outline-none transition focus:border-fire-500/60";

export function SongCreateModal({ onClose, onCreate }: { onClose: () => void; onCreate: (draft: NewSongDraft) => Promise<void> }) {
  const nextSectionKey = useRef(2);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [ccliNumber, setCcliNumber] = useState("");
  const [bpm, setBpm] = useState("");
  const [keySignature, setKeySignature] = useState("");
  const [sections, setSections] = useState<EditableSection[]>([{ key: 1, label: "Verse 1", lyrics: "" }]);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedLyrics, setPastedLyrics] = useState("");
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validBpm = bpm.trim() === "" || (/^\d+$/.test(bpm.trim()) && Number(bpm) >= 1 && Number(bpm) <= 400);
  const canSubmit = title.trim().length > 0
    && validBpm
    && sections.length > 0
    && sections.every((section) => section.label.trim() && section.lyrics.trim());

  const updateSection = (key: number, patch: Partial<Pick<EditableSection, "label" | "lyrics">>) => {
    setSections((current) => current.map((section) => section.key === key ? { ...section, ...patch } : section));
  };

  const addSection = () => {
    const key = nextSectionKey.current++;
    setSections((current) => [...current, { key, label: `Section ${current.length + 1}`, lyrics: "" }]);
  };

  const formatPastedArrangement = () => {
    const formatted = formatSongLyrics(pastedLyrics);
    if (!formatted.length) return;
    setSections(formatted.map((section) => ({ key: nextSectionKey.current++, ...section })));
    setPasteNotice(`${formatted.length} ${formatted.length === 1 ? "section" : "sections"} formatted. Review them before creating the song.`);
    setPastedLyrics("");
    setPasteOpen(false);
  };

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        title: title.trim(),
        artist: artist.trim(),
        ccliNumber: ccliNumber.trim(),
        bpm: bpm.trim() ? Number(bpm) : null,
        keySignature: keySignature.trim(),
        sections: sections.map((section) => ({ label: section.label.trim(), lyrics: section.lyrics.trim() })),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Song could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-6">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-song-title"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-board-border bg-board-card shadow-2xl"
      >
        <header className="flex items-start justify-between border-b border-board-border px-5 py-4">
          <div>
            <h2 id="new-song-title" className="font-semibold text-board-text">New song</h2>
            <p className="mt-1 text-xs text-board-muted">Add the song details and its first lyric arrangement.</p>
          </div>
          <button type="button" aria-label="Close new song" onClick={onClose} className="rounded-lg p-2 text-board-muted hover:bg-board-bg hover:text-board-text">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-5 overflow-y-auto p-5">
          {error ? <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p> : null}

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-board-muted">Song details</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-board-muted">Title<input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} className={inputClassName} /></label>
              <label className="text-xs text-board-muted">Artist<input value={artist} onChange={(event) => setArtist(event.target.value)} className={inputClassName} /></label>
              <label className="text-xs text-board-muted">CCLI number<input value={ccliNumber} onChange={(event) => setCcliNumber(event.target.value)} className={inputClassName} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-board-muted">BPM<input inputMode="numeric" value={bpm} onChange={(event) => setBpm(event.target.value)} aria-invalid={!validBpm} className={inputClassName} /></label>
                <label className="text-xs text-board-muted">Key<input value={keySignature} onChange={(event) => setKeySignature(event.target.value)} className={inputClassName} /></label>
              </div>
            </div>
            {!validBpm ? <p className="mt-2 text-xs text-red-300">BPM must be a whole number from 1 to 400.</p> : null}
          </section>

          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-board-muted">Lyrics arrangement</h3>
                <p className="mt-1 text-xs text-board-muted">Keep each section to four display lines when possible.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => { setPasteNotice(null); setPasteOpen((open) => !open); }} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-board-border px-3 text-xs font-semibold text-board-text hover:border-fire-500/40">
                  <ClipboardPaste className="h-3.5 w-3.5" />Paste and format
                </button>
                <button type="button" onClick={addSection} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-board-border px-3 text-xs font-semibold text-board-text hover:border-fire-500/40">
                  <Plus className="h-3.5 w-3.5" />Add section
                </button>
              </div>
            </div>
            {pasteOpen ? <div className="mt-3 rounded-xl border border-fire-500/30 bg-fire-500/5 p-3">
              <label className="block text-xs font-medium text-board-text">Paste the full song
                <textarea autoFocus rows={7} value={pastedLyrics} onChange={(event) => setPastedLyrics(event.target.value)} placeholder={'Verse 1\nFirst line\nSecond line\n\nChorus\nFirst chorus line'} className="mt-2 w-full resize-y rounded-lg border border-board-border bg-board-bg p-3 text-sm leading-6 text-board-text outline-none focus:border-fire-500/60" />
              </label>
              <p className="mt-2 text-xs leading-5 text-board-muted">Headings and blank lines become sections. Long sections are split into four-line display pages. Existing sections will be replaced.</p>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => { setPasteOpen(false); setPastedLyrics(""); }} className="rounded-lg px-3 py-2 text-xs font-semibold text-board-muted">Cancel paste</button>
                <button type="button" disabled={!pastedLyrics.trim()} onClick={formatPastedArrangement} className="rounded-lg bg-fire-500 px-3 py-2 text-xs font-bold text-black disabled:opacity-40">Format arrangement</button>
              </div>
            </div> : null}
            {pasteNotice ? <p role="status" className="mt-3 rounded-lg bg-green-500/10 px-3 py-2 text-xs text-green-300">{pasteNotice}</p> : null}
            <div className="mt-3 space-y-3">
              {sections.map((section, index) => (
                <div key={section.key} className="rounded-xl border border-board-border bg-board-bg p-3">
                  <div className="flex items-end gap-2">
                    <label className="min-w-0 flex-1 text-xs text-board-muted">
                      Section {index + 1} name
                      <input required value={section.label} onChange={(event) => updateSection(section.key, { label: event.target.value })} className="mt-1.5 w-full bg-transparent text-sm font-semibold text-board-text outline-none" />
                    </label>
                    <button type="button" aria-label={`Remove section ${index + 1}`} disabled={sections.length === 1} onClick={() => setSections((current) => current.filter((item) => item.key !== section.key))} className="rounded-lg p-2 text-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-25">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <label className="mt-2 block text-xs text-board-muted">
                    Section {index + 1} lyrics
                    <textarea required rows={4} value={section.lyrics} onChange={(event) => updateSection(section.key, { lyrics: event.target.value })} onPaste={(event) => { event.preventDefault(); updateSection(section.key, { lyrics: insertPastedLyrics({ value: section.lyrics, pastedText: event.clipboardData.getData("text/plain"), selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd }) }); }} placeholder="Enter the lyrics shown for this section" className="mt-1.5 w-full resize-y rounded-lg border border-board-border bg-board-card p-3 text-sm leading-6 text-board-text outline-none focus:border-fire-500/60" />
                  </label>
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer className="flex gap-2 border-t border-board-border bg-board-card px-5 py-4">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-board-border p-2.5 text-sm font-semibold text-board-muted">Cancel</button>
          <button type="submit" disabled={!canSubmit || busy} className="flex-1 rounded-xl bg-fire-500 p-2.5 text-sm font-bold text-black disabled:opacity-40">{busy ? "Creating…" : "Create song"}</button>
        </footer>
      </form>
    </div>
  );
}

export function DeleteSongModal({ title, sectionCount, cueMapCount, busy, error, onClose, onDelete }: { title: string; sectionCount: number; cueMapCount: number; busy: boolean; error: string | null; onClose: () => void; onDelete: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div role="alertdialog" aria-modal="true" aria-labelledby="delete-song-title" aria-describedby="delete-song-description" className="w-full max-w-md rounded-2xl border border-red-500/30 bg-board-card p-5 shadow-2xl">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500/10 text-red-400"><Trash2 className="h-5 w-5" /></div>
        <h2 id="delete-song-title" className="mt-4 text-lg font-semibold text-board-text">Delete "{title}"?</h2>
        <p id="delete-song-description" className="mt-2 text-sm leading-6 text-board-muted">This permanently removes the song, its {sectionCount} {sectionCount === 1 ? "section" : "sections"}, and {cueMapCount} cue {cueMapCount === 1 ? "map" : "maps"}.</p>
        {error ? <p role="alert" className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p> : null}
        <div className="mt-5 flex gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="flex-1 rounded-xl border border-board-border p-2.5 text-sm font-semibold text-board-text disabled:opacity-40">Keep song</button>
          <button type="button" disabled={busy} onClick={onDelete} className="flex-1 rounded-xl bg-red-500 p-2.5 text-sm font-bold text-white disabled:opacity-40">{busy ? "Deleting…" : "Delete song"}</button>
        </div>
      </div>
    </div>
  );
}
