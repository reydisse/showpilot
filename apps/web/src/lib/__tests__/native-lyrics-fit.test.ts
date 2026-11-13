import { expect, it } from "vitest";
import { startTextFit, advanceTextFit, lyricsReviewState, lyricsReviewMatches } from "@showpilot/shared";
import { parseMobileTimecodeState } from "../../../../mobile/src/lib/timecode-contract";
it.each([1, 12, 20, 32, 100])("converges within a quarter pixel of the measured fit at %s", threshold => {
  let fit = startTextFit(100); let count = 0;
  while (!fit.done) { fit = advanceTextFit(fit, fit.size <= threshold); expect(++count).toBeLessThan(12); }
  expect(fit.size).toBeLessThanOrEqual(threshold); expect(threshold - fit.size).toBeLessThanOrEqual(0.25);
  expect(advanceTextFit(fit, false)).toBe(fit);
});
it("preserves the native readable floor when all lyrics require a taller preview", () => {
  let fit = startTextFit(36, 12);
  while (!fit.done) fit = advanceTextFit(fit, false);
  expect(fit.size).toBe(12);
  expect(startTextFit(4, 12)).toEqual({ low: 12, high: 12, size: 12, done: true });
});
it("preserves every line and lyric generation/revision in native snapshots", () => {
  const lyrics = { songId: "song", songTitle: "Song", sectionId: "verse", sectionLabel: "Verse", lyrics: "First\n\nThird\nFourth\nFifth\nSixth", nextLabel: "Chorus", updatedAt: 10, manual: true, revision: "revision", generationKey: "load" };
  const state = parseMobileTimecodeState({ showId: "show", serviceDate: "date", triggersEnabled: true, source: "internal-freerun", format: { frameRate: 30, dropFrame: "ndf" }, running: false, serverTime: 0, totalFrames: 0, display: "00:00:00:00", timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, lyrics });
  expect(state?.lyrics).toEqual(lyrics);
  expect(lyricsReviewMatches(state?.lyrics ?? null, lyricsReviewState(lyrics))).toBe(true);
  expect(lyricsReviewMatches(null, lyricsReviewState(lyrics))).toBe(false);
  expect(lyricsReviewMatches({ ...lyrics, generationKey: "new" }, lyricsReviewState(lyrics))).toBe(false);
  expect(lyricsReviewState({ songId: "legacy", sectionId: "verse", updatedAt: 0 })).toEqual({ songId: "legacy", sectionId: "verse", updatedAt: 0, revision: null, generationKey: null });
});
