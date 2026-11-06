import { describe, expect, it } from "vitest";
import {
  mediaHeaderMatches,
  parseMediaRange,
  safeMediaName,
} from "../media-library";
import { mediaFileProblem, mediaFileType } from "../media-library-client";

describe("media containers", () => {
  it.each([
    ["video/mp4", [0, 0, 0, 24, 102, 116, 121, 112]],
    ["audio/mp4", [0, 0, 0, 24, 102, 116, 121, 112]],
    ["video/webm", [0x1a, 0x45, 0xdf, 0xa3]],
    ["audio/webm", [0x1a, 0x45, 0xdf, 0xa3]],
    ["audio/mpeg", [73, 68, 51]],
    ["audio/mpeg", [255, 251]],
    ["audio/ogg", [79, 103, 103, 83]],
    ["audio/wav", [...new TextEncoder().encode("RIFF1234WAVE")]],
  ] as const)("recognizes %s without treating HTML as media", (mime, bytes) => {
    expect(mediaHeaderMatches(new Uint8Array(bytes), mime)).toBe(true);
    expect(
      mediaHeaderMatches(new TextEncoder().encode("<!doctype html>"), mime),
    ).toBe(false);
  });
  it("normalizes browser WAV aliases and missing MIME types without accepting unsupported containers", () => {
    expect(mediaFileType({ name: "sting.wav", type: "audio/x-wav" })).toBe(
      "audio/wav",
    );
    expect(mediaFileType({ name: "BUMPER.MP4", type: "" })).toBe("video/mp4");
    expect(mediaFileType({ name: "sting.m4a", type: "" })).toBe("audio/mp4");
    expect(
      mediaFileType({ name: "pretend.mp4", type: "text/html" }),
    ).toBeNull();
    expect(
      mediaFileType({ name: "animation.mov", type: "video/quicktime" }),
    ).toBeNull();
    expect(
      mediaFileProblem(new File([], "empty.wav", { type: "audio/wav" })),
    ).toContain("empty or incomplete");
  });
  it("bounds names and seek requests", () => {
    expect(safeMediaName("a".repeat(200))).toHaveLength(180);
    expect(safeMediaName(" ")).toBe("Media");
    expect(parseMediaRange("bytes=-999", 50)).toEqual({
      offset: 0,
      length: 50,
    });
    expect(parseMediaRange("bytes=0-0", 50)).toEqual({ offset: 0, length: 1 });
    expect(parseMediaRange("bytes=49-", 50)).toEqual({ offset: 49, length: 1 });
    expect(parseMediaRange("bytes=50-", 50)).toBeNull();
  });
});
