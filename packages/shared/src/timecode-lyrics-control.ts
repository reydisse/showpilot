export type LyricsOperation = "next" | "previous" | "clear";
export type LyricsReview = {
  songId: string; sectionId: string; updatedAt: number;
  revision: string | null; generationKey: string | null;
};
export type ReviewedLyrics = Omit<LyricsReview, "revision" | "generationKey"> & { revision?: string; generationKey?: string };
export type TimecodeLyricsControl = {
  requestId: string; showId: string; serviceDate: string; operation: LyricsOperation; expected: LyricsReview;
};
export function lyricsReviewState(lyrics: ReviewedLyrics): LyricsReview {
  return { songId: lyrics.songId, sectionId: lyrics.sectionId, updatedAt: lyrics.updatedAt,
    revision: lyrics.revision ?? null, generationKey: lyrics.generationKey ?? null };
}
export function lyricsReviewMatches(lyrics: ReviewedLyrics | null, expected: LyricsReview): boolean {
  if (!lyrics) return false;
  const current = lyricsReviewState(lyrics);
  return current.songId === expected.songId && current.sectionId === expected.sectionId
    && current.updatedAt === expected.updatedAt && current.revision === expected.revision
    && current.generationKey === expected.generationKey;
}
