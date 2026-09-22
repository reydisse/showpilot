import { describe, expect, it, vi } from "vitest";
import { MtcSource } from "@/lib/timecode-sources/mtc-source";

function quarterFrame(type: number, value: number): number {
  return (type << 4) | value;
}

function feed(source: MtcSource, pieces: Array<[number, number]>) {
  const receive = source as unknown as { handleQuarterFrame(data: number): void };
  for (const [type, value] of pieces) receive.handleQuarterFrame(quarterFrame(type, value));
}

describe("MtcSource", () => {
  it("preserves 29.97 drop-frame mode", () => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    feed(source, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 1], [7, 4]]);
    expect(callback).toHaveBeenCalledWith(
      { hours: 1, minutes: 0, seconds: 0, frames: 0 },
      { frameRate: 29.97, dropFrame: "df" },
    );
  });

  it("does not publish mixed timecode after a missing quarter-frame piece", () => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    feed(source, [[0, 12], [1, 1], [2, 11], [3, 3], [4, 0], [5, 0], [6, 0], [7, 6]]);
    expect(callback).toHaveBeenCalledTimes(1);

    // Type 3 is absent. The following type 0 must reset acquisition rather
    // than completing a cycle with type 3 from the previous timestamp.
    feed(source, [[0, 0], [1, 0], [2, 0], [4, 1], [5, 0], [6, 0], [7, 6], [0, 1]]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("accepts a complete reverse quarter-frame sequence", () => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    feed(source, [[7, 6], [6, 0], [5, 0], [4, 1], [3, 0], [2, 2], [1, 0], [0, 3]]);
    expect(callback).toHaveBeenCalledWith(
      { hours: 0, minutes: 1, seconds: 2, frames: 3 },
      { frameRate: 30, dropFrame: "ndf" },
    );
  });
});
