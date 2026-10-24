import { describe, expect, it } from "vitest";
// The browser and tests execute the same dependency-free demo model.
import {
  initialState,
  selectCue,
  tick,
  togglePlayback,
  nextCue,
  formatClock,
} from "../static/concept/demo-state.js";

describe("concept show preview", () => {
  it("freezes the remaining time on pause and resumes from that time", () => {
    const paused = togglePlayback(initialState(1_000), 3_000);
    expect(paused.mode).toBe("paused");
    expect(paused.remainingMs).toBe(270_000);
    expect(tick(paused, 50_000)).toEqual(paused);
    const resumed = togglePlayback(paused, 50_000);
    expect(tick(resumed, 51_000).remainingMs).toBe(269_000);
  });

  it("carries elapsed time across cues after a hidden tab returns", () => {
    const state = tick(selectCue(0, 0), 610_000);
    expect(state.cueIndex).toBe(2);
    expect(state.remainingMs).toBe(470_000);
  });

  it("ends instead of looping after the final cue and supports replay", () => {
    const complete = tick(selectCue(3, 0), 300_000);
    expect(complete.mode).toBe("complete");
    expect(complete.remainingMs).toBe(0);
    expect(nextCue(selectCue(3, 0), 10).mode).toBe("complete");
    expect(togglePlayback(complete, 400_000)).toEqual(selectCue(0, 400_000));
  });

  it("formats the clock without a negative or fractional second", () => {
    expect(formatClock(272_000)).toBe("04:32");
    expect(formatClock(1)).toBe("00:01");
    expect(formatClock(-1)).toBe("00:00");
  });
});
