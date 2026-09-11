import { describe, expect, it } from "vitest";
import { formatSongLyrics, insertPastedLyrics, normalizeLyricsText } from "./song-lyrics-format";

describe("normalizeLyricsText", () => {
  it("removes clipboard artifacts while keeping intentional line breaks", () => {
    expect(normalizeLyricsText("  First\u00a0line  \r\nSecond   line\r\n\r\n\r\nThird\u200B line  ")).toBe("First line\nSecond line\n\nThird line");
  });
});

describe("formatSongLyrics", () => {
  it("recognizes common section headings and paginates at four lines", () => {
    expect(formatSongLyrics("[VERSE 1]\nOne\nTwo\nThree\nFour\nFive\n\nChorus:\nSix\nSeven")).toEqual([
      { label: "Verse 1 1/2", lyrics: "One\nTwo\nThree\nFour" },
      { label: "Verse 1 2/2", lyrics: "Five" },
      { label: "Chorus", lyrics: "Six\nSeven" },
    ]);
  });

  it("uses blank lines to split lyrics without headings", () => {
    expect(formatSongLyrics("One\nTwo\n\nThree\nFour")).toEqual([
      { label: "Section 1", lyrics: "One\nTwo" },
      { label: "Section 2", lyrics: "Three\nFour" },
    ]);
  });
});

describe("insertPastedLyrics", () => {
  it("inserts normalized plain text at the current selection", () => {
    expect(insertPastedLyrics({ value: "Start end", pastedText: "middle\r\nline", selectionStart: 6, selectionEnd: 6 })).toBe("Start middle\nlineend");
  });
});
