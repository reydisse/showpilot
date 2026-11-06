import { describe, expect, it } from "vitest";
import {
  TimecodePresentationClock,
  type TimecodePresentationSample,
} from "../timecode-presentation";
import { framesToTimecode, timecodeToString } from "../timecode";
import type { TimecodeFormat, TimecodeState } from "@/types/timecode";

const format = { frameRate: 30, dropFrame: "ndf" } as const;
function sample(
  frame: number,
  feedAt: number,
  fmt: TimecodeFormat = format,
): TimecodePresentationSample {
  return {
    showId: "show",
    display: timecodeToString(
      framesToTimecode(frame, fmt),
      fmt.dropFrame === "df",
    ),
    totalFrames: frame,
    format: fmt,
    running: true,
    serverTime: feedAt,
    signal: { status: "live", lastFeedAt: feedAt },
  };
}

describe("timecode presentation buffer", () => {
  it("renders intermediate known frames at 10 Hz without predicting beyond the last sample", () => {
    const clock = new TimecodePresentationClock();
    clock.observe(sample(300, 10_000), true, 0);
    expect(clock.read(99).display).toBe("00:00:10:00");
    clock.observe(sample(303, 10_100), true, 100);
    expect(clock.read(100).display).toBe("00:00:10:00");
    expect(clock.read(134).display).toBe("00:00:10:01");
    expect(clock.read(167).display).toBe("00:00:10:02");
    expect(clock.read(200).display).toBe("00:00:10:03");
    expect(clock.read(599)).toEqual({ display: "00:00:10:03", stale: false });
    expect(clock.read(600)).toEqual({ display: "00:00:10:03", stale: true });
    expect(clock.needsTick(600)).toBe(false);
  });

  it("does not rewind on jitter or let duplicate/lyrics broadcasts refresh a dead feed", () => {
    const clock = new TimecodePresentationClock();
    clock.observe(sample(300, 10_000), true, 0);
    clock.observe(sample(303, 10_100), true, 100);
    expect(clock.read(180).display).toBe("00:00:10:02");
    clock.observe(sample(306, 10_200), true, 180);
    expect(clock.read(180).display).toBe("00:00:10:02");
    const frames = [180, 200, 220, 240, 260, 280].map(
      (now) => clock.read(now).display,
    );
    expect(frames).toEqual([...frames].sort());
    clock.observe({ ...sample(306, 10_200), serverTime: 10_600 }, true, 600);
    expect(clock.read(680)).toEqual({ display: "00:00:10:06", stale: true });
  });

  it.each<TimecodeState["signal"]>([
    { status: "idle", lastFeedAt: 10_100 },
    { status: "paused", lastFeedAt: 10_100 },
    { status: "midi-stopped", lastFeedAt: 10_100 },
    { status: "midi-waiting", lastFeedAt: 10_100 },
    { status: "timecode-stalled", lastFeedAt: 10_100 },
    { status: "timecode-lost", lastFeedAt: 10_100 },
    { status: "format-mismatch", lastFeedAt: 10_100 },
    { status: "waiting", lastFeedAt: null },
  ])("snaps to the held position for $status", (signal) => {
    const clock = new TimecodePresentationClock();
    clock.observe(sample(300, 10_000), true, 0);
    clock.observe(sample(303, 10_100), true, 100);
    clock.observe(
      { ...sample(303, 10_100), running: false, signal },
      true,
      120,
    );
    expect(clock.read(121).display).toBe("00:00:10:03");
    expect(clock.read(10_000).display).toBe("00:00:10:03");
    expect(clock.needsTick(121)).toBe(false);
  });

  it("holds on disconnect, does not freshen an old hydrate, and snaps on new scope or seek", () => {
    const clock = new TimecodePresentationClock();
    clock.observe(sample(300, 10_000), true, 0);
    clock.observe(sample(303, 10_100), true, 100);
    clock.observe(sample(303, 10_100), false, 120);
    expect(clock.read(121).display).toBe("00:00:10:03");
    expect(clock.needsTick(121)).toBe(false);
    clock.observe(sample(303, 10_100), true, 700);
    expect(clock.read(700).stale).toBe(true);
    clock.observe(sample(310, 10_800), true, 800);
    expect(clock.read(800).display).toBe("00:00:10:10");
    clock.observe(sample(600, 10_900), true, 900);
    expect(clock.read(900).display).toBe("00:00:20:00");
    clock.observe(sample(300, 11_000), true, 1000);
    expect(clock.read(1000).display).toBe("00:00:10:00");
    clock.observe({ ...sample(303, 11_100), showId: "another" }, true, 1100);
    expect(clock.read(1100).display).toBe("00:00:10:03");
    clock.observe(null, false, 1200);
    expect(clock.read(1200).display).toBe("00:00:00:00");
  });

  it.each<TimecodeFormat>([
    { frameRate: 24, dropFrame: "ndf" },
    { frameRate: 25, dropFrame: "ndf" },
    { frameRate: 29.97, dropFrame: "df" },
    { frameRate: 29.97, dropFrame: "ndf" },
    format,
  ])(
    "keeps $frameRate $dropFrame labels valid through a minute boundary",
    (fmt) => {
      const clock = new TimecodePresentationClock();
      const frame = Math.round(fmt.frameRate) * 60 - 1;
      clock.observe(sample(frame, 10_000, fmt), true, 0);
      clock.observe(sample(frame + 3, 10_100, fmt), true, 100);
      expect(clock.read(134).display).toBe(
        timecodeToString(
          framesToTimecode(frame + 1, fmt),
          fmt.dropFrame === "df",
        ),
      );
      expect(clock.read(200).display).toBe(
        timecodeToString(
          framesToTimecode(frame + 3, fmt),
          fmt.dropFrame === "df",
        ),
      );
    },
  );

  it("ignores client wall-clock skew and accounts for feed age at the server", () => {
    const clock = new TimecodePresentationClock();
    const incoming = { ...sample(300, 1_000_000), serverTime: 1_000_400 };
    clock.observe(incoming, true, 20);
    expect(clock.read(119).stale).toBe(false);
    expect(clock.read(120).stale).toBe(true);
    clock.observe(
      { ...sample(301, 1_000_500), serverTime: 1_001_100 },
      true,
      130,
    );
    expect(clock.read(130)).toEqual({ display: "00:00:10:01", stale: true });
  });

  it("leaves pre-interpolation snapshots readable without inventing clock metadata", () => {
    const clock = new TimecodePresentationClock();
    clock.observe(
      { display: "00:00:10:00", running: true, serverTime: 1 },
      true,
      0,
    );
    expect(clock.read(1000)).toEqual({ display: "00:00:10:00", stale: false });
    expect(clock.needsTick(0)).toBe(false);
  });

  it("snaps to a reformatted clock instead of blending incompatible frame counts", () => {
    const clock = new TimecodePresentationClock();
    clock.observe(sample(300, 10_000), true, 0);
    clock.observe(sample(303, 10_100), true, 100);
    clock.observe(
      sample(250, 10_120, { frameRate: 25, dropFrame: "ndf" }),
      true,
      120,
    );
    expect(clock.read(120).display).toBe("00:00:10:00");
  });
});
