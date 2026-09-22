import { describe, expect, it } from "vitest";
import { projectTimecodeDisplayState } from "../timecode-display";
import type { TimecodeState } from "@/types/timecode";

describe("public timecode display projection", () => {
  it("retains display output without exposing internal control fields", () => {
    const state: TimecodeState = {
      timecode: { hours: 1, minutes: 2, seconds: 3, frames: 4 },
      display: "01:02:03:04",
      source: "mtc",
      format: { frameRate: 29.97, dropFrame: "df" },
      running: true,
      serverTime: 1,
      totalFrames: 111_222,
      lyrics: null,
    };

    const result = projectTimecodeDisplayState(state, 500);

    expect(result).toEqual({
      display: "01:02:03:04",
      running: true,
      serverTime: 500,
      lyrics: null,
    });
    expect(result).not.toHaveProperty("source");
    expect(result).not.toHaveProperty("format");
    expect(result).not.toHaveProperty("totalFrames");
  });
});
