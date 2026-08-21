import { describe, expect, it } from "vitest";
import { rebaseTimerToLocalClock } from "../rundown-clock";

describe("rundown relay clock rebasing", () => {
  it("shows identical elapsed time on devices with different wall clocks", () => {
    const relayTimer = {
      playback: "play" as const,
      currentItemId: "item-1",
      elapsed: 5_000,
      startedAt: 1_000_000,
      pausedAt: null,
      mode: "count-down" as const,
      serverTime: 1_010_000,
    };

    const accurateDevice = rebaseTimerToLocalClock(relayTimer, 1_010_100);
    const fastDevice = rebaseTimerToLocalClock(relayTimer, 1_070_100);

    expect(accurateDevice.elapsed + (1_010_100 - accurateDevice.startedAt!)).toBe(15_000);
    expect(fastDevice.elapsed + (1_070_100 - fastDevice.startedAt!)).toBe(15_000);
  });

  it("preserves negative elapsed offsets used for added time", () => {
    const timer = rebaseTimerToLocalClock(
      {
        elapsed: -60_000,
        startedAt: 2_000,
        pausedAt: null,
        serverTime: 3_000,
      },
      8_000,
    );

    expect(timer.elapsed).toBe(-60_000);
    expect(timer.startedAt).toBe(7_000);
  });
});
