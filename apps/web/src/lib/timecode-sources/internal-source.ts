import type { TimecodeValue, TimecodeFormat } from "@/types/timecode";
import { msToTimecode, timecodeToFrames, timecodeToString } from "@/lib/timecode";

export interface InternalSourceCallback {
  (tc: TimecodeValue, totalFrames: number, display: string): void;
}

/**
 * Internal timecode generator — runs in the browser using requestAnimationFrame.
 * Two modes:
 * - Freerun: counts from a start offset using performance.now()
 * - Rundown: takes elapsed ms from external source (rundown timer)
 */
export class InternalTimecodeSource {
  private running = false;
  private rafId: number | null = null;
  private startTime = 0;
  private offset = 0; // ms offset for start timecode
  private format: TimecodeFormat;
  private onTimecode: InternalSourceCallback;
  private lastEmittedFrame = -1;

  constructor(format: TimecodeFormat, callback: InternalSourceCallback) {
    this.format = format;
    this.onTimecode = callback;
  }

  start(startOffsetMs = 0): void {
    this.offset = startOffsetMs;
    this.startTime = performance.now();
    this.running = true;
    this.lastEmittedFrame = -1;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  setFormat(format: TimecodeFormat): void {
    this.format = format;
  }

  /** Feed external elapsed ms (for rundown-derived mode) */
  feedElapsed(ms: number): void {
    const tc = msToTimecode(ms, this.format);
    const totalFrames = timecodeToFrames(tc, this.format);
    if (totalFrames !== this.lastEmittedFrame) {
      this.lastEmittedFrame = totalFrames;
      const display = timecodeToString(tc, this.format.dropFrame === "df");
      this.onTimecode(tc, totalFrames, display);
    }
  }

  private tick = (): void => {
    if (!this.running) return;

    const elapsed = performance.now() - this.startTime + this.offset;
    const tc = msToTimecode(elapsed, this.format);
    const totalFrames = timecodeToFrames(tc, this.format);

    // Only emit when frame changes (avoids flooding at 60Hz RAF)
    if (totalFrames !== this.lastEmittedFrame) {
      this.lastEmittedFrame = totalFrames;
      const display = timecodeToString(tc, this.format.dropFrame === "df");
      this.onTimecode(tc, totalFrames, display);
    }

    this.rafId = requestAnimationFrame(this.tick);
  };
}
