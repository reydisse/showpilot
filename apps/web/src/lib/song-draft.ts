import type { TimecodeFormat } from "@/types/timecode";

export interface SongMetadataDraft {
  title: string;
  artist: string;
  ccliNumber: string;
  bpm: string;
  keySignature: string;
}

export interface SongSectionDraft {
  id: string;
  label: string;
  lyrics: string;
  sourceSlideIndex: number | null;
}

export interface SongCueDraft {
  sectionId: string;
  triggerTc: string;
  ppSlideIndex: number | null;
}

export interface SongMapDraft {
  id: string;
  name: string;
  format: TimecodeFormat;
  cues: SongCueDraft[];
}

export interface SongDraft {
  metadata: SongMetadataDraft;
  sections: SongSectionDraft[];
  cueMap: SongMapDraft;
}

export function songDraftFingerprint(draft: SongDraft): string {
  return JSON.stringify(draft);
}

export function isSongDraftDirty(current: SongDraft, saved: SongDraft): boolean {
  return songDraftFingerprint(current) !== songDraftFingerprint(saved);
}

export function isCueMapDraftDirty(
  current: SongMapDraft,
  saved: SongMapDraft,
): boolean {
  return JSON.stringify(current) !== JSON.stringify(saved);
}

export function reconcileSavedSection(
  saved: SongDraft,
  section: SongSectionDraft,
): SongDraft {
  return {
    ...saved,
    sections: saved.sections.map((candidate) =>
      candidate.id === section.id ? section : candidate,
    ),
  };
}
