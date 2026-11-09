import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalTimecodeSource } from "../timecode-sources/internal-source";
import { startTimecodeTicker } from "../timecode-sources/timecode-ticker";
import { framesToTimecode } from "../timecode";
import type { TimecodeFormat } from "@/types/timecode";

class TickWorker {
  static instances: TickWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    TickWorker.instances.push(this);
  }
  tick() {
    this.onmessage?.({ data: "tick" });
  }
}
const formats: TimecodeFormat[] = [
  { frameRate: 24, dropFrame: "ndf" },
  { frameRate: 25, dropFrame: "ndf" },
  { frameRate: 29.97, dropFrame: "df" },
  { frameRate: 30, dropFrame: "ndf" },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  TickWorker.instances = [];
  vi.stubGlobal("Worker", TickWorker);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => {
      throw new Error("Clock depends on rendering");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("internal timecode clock", () => {
  it.each(formats)(
    "advances from the exact held frame at $frameRate $dropFrame without animation frames",
    (format) => {
      const emit = vi.fn();
      const source = new InternalTimecodeSource(format, emit);
      source.startAtFrame(1800);
      expect(emit.mock.calls[0].slice(0, 2)).toEqual([
        framesToTimecode(1800, format),
        1800,
      ]);
      const worker = TickWorker.instances[0];
      vi.advanceTimersByTime(2_000);
      worker.tick();
      expect(emit.mock.lastCall?.[1]).toBe(
        1800 + Math.floor(2 * format.frameRate),
      );
      // A delayed batch of worker messages cannot replay frames or cues.
      worker.tick();
      worker.tick();
      expect(emit).toHaveBeenCalledTimes(2);
      source.stop();
      const held = source.currentFrame();
      vi.advanceTimersByTime(5_000);
      worker.tick();
      expect(source.currentFrame()).toBe(held);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it("cancels the old worker and resumes from the new authoritative frame", () => {
    const emit = vi.fn();
    const source = new InternalTimecodeSource(formats[3], emit);
    source.startAtFrame(0);
    const old = TickWorker.instances[0];
    vi.advanceTimersByTime(2_000);
    old.tick();
    source.startAtFrame(500);
    expect(emit.mock.lastCall?.[1]).toBe(500);
    old.tick();
    expect(emit).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    TickWorker.instances[1].tick();
    expect(emit.mock.lastCall?.[1]).toBe(530);
    source.stop();
  });

  it("emits about 30 fresh frames per second with the interval fallback, then stops", () => {
    vi.stubGlobal("Worker", undefined);
    const emit = vi.fn();
    const source = new InternalTimecodeSource(formats[3], emit);
    source.startAtFrame(300);
    vi.advanceTimersByTime(1_000);
    expect(emit.mock.calls.length).toBeGreaterThanOrEqual(29);
    expect(emit.mock.calls.length).toBeLessThanOrEqual(31);
    expect(emit.mock.calls[0][1]).toBe(300);
    expect(emit.mock.lastCall?.[1]).toBeGreaterThanOrEqual(329);
    source.stop();
    const count = emit.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(count);
  });

  it("falls back once if a worker fails to load and ignores messages after disposal", () => {
    const tick = vi.fn();
    const stop = startTimecodeTicker(tick);
    const worker = TickWorker.instances[0];
    worker.onmessage?.({ data: "unexpected" });
    expect(tick).not.toHaveBeenCalled();
    worker.onerror?.();
    worker.onerror?.();
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    worker.tick();
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
