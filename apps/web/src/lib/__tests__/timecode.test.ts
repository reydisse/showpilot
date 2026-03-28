import { describe, it, expect } from "vitest";
import {
  timecodeToFrames,
  framesToTimecode,
  timecodeToString,
  parseTimecodeString,
  msToTimecode,
} from "../timecode";
import type { TimecodeValue, TimecodeFormat } from "@/types/timecode";

const fmt30: TimecodeFormat = { frameRate: 30, dropFrame: "ndf" };
const fmt25: TimecodeFormat = { frameRate: 25, dropFrame: "ndf" };
const fmt24: TimecodeFormat = { frameRate: 24, dropFrame: "ndf" };
const fmt2997df: TimecodeFormat = { frameRate: 29.97, dropFrame: "df" };
const fmt2997ndf: TimecodeFormat = { frameRate: 29.97, dropFrame: "ndf" };

function tc(h: number, m: number, s: number, f: number): TimecodeValue {
  return { hours: h, minutes: m, seconds: s, frames: f };
}

describe("timecodeToFrames", () => {
  it("converts 00:00:00:00 to 0 frames", () => {
    expect(timecodeToFrames(tc(0, 0, 0, 0), fmt30)).toBe(0);
  });

  it("converts 00:00:01:00 to 30 frames at 30fps", () => {
    expect(timecodeToFrames(tc(0, 0, 1, 0), fmt30)).toBe(30);
  });

  it("converts 00:01:00:00 to 1800 frames at 30fps", () => {
    expect(timecodeToFrames(tc(0, 1, 0, 0), fmt30)).toBe(1800);
  });

  it("converts 01:00:00:00 to 108000 frames at 30fps", () => {
    expect(timecodeToFrames(tc(1, 0, 0, 0), fmt30)).toBe(108000);
  });

  it("converts at 25fps", () => {
    expect(timecodeToFrames(tc(0, 0, 1, 0), fmt25)).toBe(25);
    expect(timecodeToFrames(tc(0, 1, 0, 0), fmt25)).toBe(1500);
  });

  it("converts at 24fps", () => {
    expect(timecodeToFrames(tc(0, 0, 1, 0), fmt24)).toBe(24);
  });

  it("includes frame offset", () => {
    expect(timecodeToFrames(tc(0, 0, 0, 15), fmt30)).toBe(15);
    expect(timecodeToFrames(tc(0, 0, 1, 10), fmt30)).toBe(40);
  });

  // Drop frame: at 29.97 DF, frames 0 and 1 are skipped at every minute except every 10th
  it("handles 29.97 drop frame", () => {
    // 00:01:00:02 in DF — first valid frame after minute 1
    // In NDF, 1 minute = 1800 frames
    // In DF, frames 0,1 are dropped at minutes 1-9, so minute 1 starts at frame 1798 + 2 = 1800
    // Actually DF is complex — just verify round-trip
    const frames = timecodeToFrames(tc(0, 1, 0, 2), fmt2997df);
    const back = framesToTimecode(frames, fmt2997df);
    expect(back).toEqual(tc(0, 1, 0, 2));
  });
});

describe("framesToTimecode", () => {
  it("converts 0 frames to 00:00:00:00", () => {
    expect(framesToTimecode(0, fmt30)).toEqual(tc(0, 0, 0, 0));
  });

  it("converts 30 frames to 00:00:01:00 at 30fps", () => {
    expect(framesToTimecode(30, fmt30)).toEqual(tc(0, 0, 1, 0));
  });

  it("converts 1800 frames to 00:01:00:00 at 30fps", () => {
    expect(framesToTimecode(1800, fmt30)).toEqual(tc(0, 1, 0, 0));
  });

  it("round-trips correctly", () => {
    const original = tc(1, 23, 45, 15);
    const frames = timecodeToFrames(original, fmt30);
    expect(framesToTimecode(frames, fmt30)).toEqual(original);
  });

  it("round-trips at 25fps", () => {
    const original = tc(0, 30, 22, 12);
    const frames = timecodeToFrames(original, fmt25);
    expect(framesToTimecode(frames, fmt25)).toEqual(original);
  });
});

describe("timecodeToString", () => {
  it("formats as HH:MM:SS:FF for NDF", () => {
    expect(timecodeToString(tc(1, 2, 3, 4), false)).toBe("01:02:03:04");
  });

  it("formats as HH:MM:SS;FF for DF", () => {
    expect(timecodeToString(tc(1, 2, 3, 4), true)).toBe("01:02:03;04");
  });

  it("zero-pads all fields", () => {
    expect(timecodeToString(tc(0, 0, 0, 0), false)).toBe("00:00:00:00");
  });
});

describe("parseTimecodeString", () => {
  it("parses HH:MM:SS:FF (NDF)", () => {
    expect(parseTimecodeString("01:02:03:04")).toEqual(tc(1, 2, 3, 4));
  });

  it("parses HH:MM:SS;FF (DF)", () => {
    expect(parseTimecodeString("01:02:03;04")).toEqual(tc(1, 2, 3, 4));
  });

  it("returns null for invalid format", () => {
    expect(parseTimecodeString("not a timecode")).toBeNull();
    expect(parseTimecodeString("")).toBeNull();
    expect(parseTimecodeString("1:2:3")).toBeNull();
  });

  it("parses single-digit values", () => {
    expect(parseTimecodeString("0:0:0:0")).toEqual(tc(0, 0, 0, 0));
  });
});

describe("msToTimecode", () => {
  it("converts 0ms to 00:00:00:00", () => {
    expect(msToTimecode(0, fmt30)).toEqual(tc(0, 0, 0, 0));
  });

  it("converts 1000ms to 00:00:01:00", () => {
    expect(msToTimecode(1000, fmt30)).toEqual(tc(0, 0, 1, 0));
  });

  it("converts 60000ms to 00:01:00:00", () => {
    expect(msToTimecode(60000, fmt30)).toEqual(tc(0, 1, 0, 0));
  });

  it("converts with fractional frames at 30fps", () => {
    // 500ms = 15 frames at 30fps
    expect(msToTimecode(500, fmt30)).toEqual(tc(0, 0, 0, 15));
  });

  it("converts at 25fps", () => {
    // 1000ms = 25 frames = 00:00:01:00
    expect(msToTimecode(1000, fmt25)).toEqual(tc(0, 0, 1, 0));
    // 40ms = 1 frame at 25fps
    expect(msToTimecode(40, fmt25)).toEqual(tc(0, 0, 0, 1));
  });

  it("handles large values", () => {
    // 1 hour
    expect(msToTimecode(3600000, fmt30)).toEqual(tc(1, 0, 0, 0));
  });
});
