import type { LyricsDisplayState } from "@/types/timecode";

/** Resolve against the saved song order, never the order of timed cues. */
export async function resolveLyricsStep(
  db: D1Database,
  orgId: string,
  current: LyricsDisplayState | null,
  direction: "next" | "previous",
): Promise<LyricsDisplayState> {
  if (!current) throw new Error("Show a song section before stepping lyrics.");
  const sections = await db.prepare(
    `SELECT section.id, section.label, section.lyrics, song.title AS songTitle
     FROM song_section AS section JOIN song ON song.id = section.songId AND song.orgId = section.orgId
     WHERE section.orgId = ? AND section.songId = ? ORDER BY section.sortOrder, section.id`,
  ).bind(orgId, current.songId).all<{ id: string; label: string; lyrics: string; songTitle: string }>();
  const index = sections.results.findIndex(section => section.id === current.sectionId);
  if (index < 0) throw new Error("The displayed song section is no longer available. Choose a saved section in Songs.");
  const nextIndex = index + (direction === "next" ? 1 : -1);
  const selected = sections.results[nextIndex];
  if (!selected) throw new Error(`Already at the ${direction === "next" ? "last" : "first"} song section.`);
  return {
    ...current,
    songTitle: selected.songTitle,
    sectionId: selected.id,
    sectionLabel: selected.label,
    lyrics: selected.lyrics,
    nextLabel: sections.results[nextIndex + 1]?.label ?? "",
    updatedAt: Date.now(),
  };
}
