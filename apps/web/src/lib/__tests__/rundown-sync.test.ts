import { describe, expect, it } from "vitest";
import { normalizeTimerState } from "../../hooks/useRundownSync";

describe("rundown relay timer normalization", () => {
  it("preserves negative elapsed offsets added beyond assigned duration", () => {
    const timer = normalizeTimerState({
      playback: "play",
      currentItemId: "item-1",
      elapsed: -60_000,
      startedAt: 1_000,
      pausedAt: null,
      mode: "count-down",
      serverTime: 1_000,
    });

    expect(timer.elapsed).toBe(-60_000);
  });

  it("still normalizes non-finite elapsed values to zero", () => {
    expect(normalizeTimerState({ elapsed: Number.NaN }).elapsed).toBe(0);
  });
});
