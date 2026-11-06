import type { TimecodeValue, TimecodeFormat } from "@/types/timecode";
import { framesToTimecode, msToTimecode, timecodeToFrames, timecodeToString } from "@/lib/timecode";
import { startTimecodeTicker } from "./timecode-ticker";

export interface InternalSourceCallback {
  (tc: TimecodeValue, totalFrames: number, display: string): void;
}

/**
 * Internal timecode generator, sampled independently of rendering.
 * Two modes:
 * - Freerun: counts from a start offset using performance.now()
 * - Rundown: takes elapsed ms from external source (rundown timer)
 */
export class InternalTimecodeSource {
  private running = false;
  private stopTicker: (() => void) | null = null;
  private startTime = 0;
  private offsetFrames = 0;
  private format: TimecodeFormat;
  private onTimecode: InternalSourceCallback;
  private lastEmittedFrame = -1;

  constructor(format: TimecodeFormat, callback: InternalSourceCallback) {
    this.format = format;
    this.onTimecode = callback;
  }

  start(startOffsetMs = 0): void {
    this.startAtFrame(Math.floor(Math.max(0, startOffsetMs) * this.format.frameRate / 1000));
  }

  /** Resume the relay's exact held frame, including drop-frame boundaries. */
  startAtFrame(frame: number): void {
    this.stop();
    this.offsetFrames = Math.max(0, Math.floor(frame));
    this.startTime = performance.now();
    this.running = true;
    this.lastEmittedFrame = -1;
    // Sample twice per maximum frame period so timer jitter around a frame
    // boundary does not reduce the 30 fps feed to roughly 27 fps.
    this.stopTicker = startTimecodeTicker(this.tick, 60);
    this.tick();
  }

  stop(): void {
    this.offsetFrames = this.currentFrame();
    this.running = false;
    this.stopTicker?.();
    this.stopTicker = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  currentFrame(): number {
    return this.offsetFrames + (this.running ? Math.floor((performance.now() - this.startTime) * this.format.frameRate / 1000) : 0);
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

    const elapsedFrames = Math.floor((performance.now() - this.startTime) * this.format.frameRate / 1000);
    const totalFrames = this.offsetFrames + elapsedFrames;
    const tc = framesToTimecode(totalFrames, this.format);

    // Coalesced worker messages must not repeat an already emitted frame.
    if (totalFrames !== this.lastEmittedFrame) {
      this.lastEmittedFrame = totalFrames;
      const display = timecodeToString(tc, this.format.dropFrame === "df");
      this.onTimecode(tc, totalFrames, display);
    }
  };
}
