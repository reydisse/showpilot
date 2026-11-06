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
  const before = [12, 1, 11, 3, 0, 0, 0, 6]; // 00:00:59:28
  const after = [0, 0, 0, 0, 1, 0, 0, 6]; // 00:01:00:00
  const forward = [0, 1, 2, 3, 4, 5, 6, 7];
  function sequence(source: MtcSource, values: number[], order = forward) {
    feed(source, order.map((piece) => [piece, values[piece]]));
  }

  it("emits once per complete cycle, matching the native Bridge decoder", () => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    sequence(source, before);
    sequence(source, after);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(
      { hours: 0, minutes: 1, seconds: 0, frames: 0 },
      { frameRate: 30, dropFrame: "ndf" },
    );
  });

  it.each(forward)("recovers without stale pieces when piece %i is dropped", (missing) => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    sequence(source, before);
    sequence(source, after, forward.filter((piece) => piece !== missing));
    expect(callback).toHaveBeenCalledTimes(1);
    sequence(source, after);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(
      { hours: 0, minutes: 1, seconds: 0, frames: 0 },
      { frameRate: 30, dropFrame: "ndf" },
    );
  });

  it.each([0, 1, 2, 3, 4, 5, 6])("rejects adjacent pieces reordered at %i", (swapped) => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    const order = [...forward];
    [order[swapped], order[swapped + 1]] = [order[swapped + 1], order[swapped]];
    sequence(source, after, order);
    expect(callback).not.toHaveBeenCalled();
  });

  it("reacquires after a direction change and supports wrapping across piece zero", () => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    sequence(source, after, [0, 1, 2, 1, 0, 7, 6, 5, 4]);
    expect(callback).not.toHaveBeenCalled();
    sequence(source, after, [3, 2]);
    expect(callback).toHaveBeenCalledTimes(1);
    sequence(source, after, [4, 5, 6, 7, 0, 1, 2, 3]);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeated piece until another complete sequence arrives", () => {
    const callback = vi.fn();
    const source = new MtcSource(callback);
    sequence(source, after, [0, 1, 2, 3, 3, 4, 5, 6, 7]);
    expect(callback).not.toHaveBeenCalled();
  });

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
