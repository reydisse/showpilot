import { TIMECODE_FEED_STALL_MS, type TimecodeState } from "@/types/timecode";
import {
  framesToTimecode,
  isValidTimecodeFormat,
  sameTimecodeFormat,
  timecodeToString,
} from "./timecode";

/** Presentation only. Never use these interpolated positions for commands/cues. */
export type TimecodePresentationSample = Pick<
  TimecodeState,
  "display" | "running" | "serverTime" | "signal" | "showId"
> &
  Partial<Pick<TimecodeState, "format" | "totalFrames">>;
type ClockSample = TimecodePresentationSample &
  Required<Pick<TimecodeState, "format" | "totalFrames">>;
type LiveClockSample = ClockSample & {
  signal: { status: "live"; lastFeedAt: number };
};
export interface TimecodePresentation {
  display: string;
  stale: boolean;
}

function hasClock(
  sample: TimecodePresentationSample | null,
): sample is ClockSample {
  return (
    sample !== null &&
    isValidTimecodeFormat(sample.format) &&
    typeof sample.totalFrames === "number" &&
    Number.isSafeInteger(sample.totalFrames) &&
    sample.totalFrames >= 0 &&
    Number.isFinite(sample.serverTime)
  );
}
function live(
  sample: TimecodePresentationSample | null,
): sample is LiveClockSample {
  return (
    hasClock(sample) &&
    sample.running &&
    sample.signal?.status === "live" &&
    typeof sample.signal.lastFeedAt === "number" &&
    Number.isFinite(sample.signal.lastFeedAt)
  );
}

/** Buffer at most 100 ms between known frames; never predict beyond the relay. */
export class TimecodePresentationClock {
  private sample: TimecodePresentationSample | null = null;
  private connected = false;
  private freshUntil = 0;
  private span = { from: 0, to: 0, at: 0, duration: 0 };

  private frame(now: number): number {
    const { from, to, at, duration } = this.span;
    const fraction =
      duration > 0 ? Math.max(0, Math.min(1, (now - at) / duration)) : 1;
    return Math.floor(from + (to - from) * fraction);
  }

  observe(
    sample: TimecodePresentationSample | null,
    connected: boolean,
    now: number,
  ): void {
    const previous = this.sample;
    const wasConnected = this.connected;
    this.connected = connected;
    const currentFrame = this.frame(now);
    this.sample = sample;
    if (!live(sample) || !connected) {
      const frame = sample?.totalFrames ?? 0;
      this.span = { from: frame, to: frame, at: now, duration: 0 };
      return;
    }
    const sameScope =
      hasClock(previous) &&
      previous.showId === sample.showId &&
      sameTimecodeFormat(previous.format, sample.format);
    const feedAt = sample.signal.lastFeedAt;
    // Lyrics, cue acknowledgements and duplicate broadcasts are not fresh feeds.
    if (
      sameScope &&
      live(previous) &&
      previous.totalFrames === sample.totalFrames &&
      previous.signal.lastFeedAt === feedAt
    )
      return;
    const gap = feedAt - (previous?.signal?.lastFeedAt ?? feedAt);
    const delta =
      sample.totalFrames - (previous?.totalFrames ?? sample.totalFrames);
    const continuous =
      wasConnected &&
      sameScope &&
      live(previous) &&
      now < this.freshUntil &&
      gap > 0 &&
      gap < TIMECODE_FEED_STALL_MS &&
      delta >= 0 &&
      delta <= Math.ceil((gap * sample.format.frameRate) / 1000) + 1;
    this.freshUntil =
      now +
      Math.max(
        0,
        TIMECODE_FEED_STALL_MS - Math.max(0, sample.serverTime - feedAt),
      );
    this.span = {
      from: continuous
        ? Math.min(currentFrame, sample.totalFrames)
        : sample.totalFrames,
      to: sample.totalFrames,
      at: now,
      duration: continuous ? Math.min(gap, 100) : 0,
    };
  }

  read(now: number): TimecodePresentation {
    const sample = this.sample;
    const stale = this.connected && live(sample) && now >= this.freshUntil;
    const display =
      this.connected && live(sample) && !stale
        ? timecodeToString(
            framesToTimecode(this.frame(now), sample.format),
            sample.format.dropFrame === "df",
          )
        : (sample?.display ?? "00:00:00:00");
    return { display, stale };
  }

  needsTick(now: number): boolean {
    return this.connected && live(this.sample) && now < this.freshUntil;
  }
}
