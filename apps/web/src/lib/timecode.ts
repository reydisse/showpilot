import type { TimecodeValue, TimecodeFormat } from "@/types/timecode";

/**
 * Convert a TimecodeValue to total frame count.
 * For 29.97 drop frame: frames 0,1 are dropped at every minute except every 10th.
 */
export function timecodeToFrames(
  tc: TimecodeValue,
  format: TimecodeFormat
): number {
  const fps = Math.round(format.frameRate); // 30 for both 29.97 and 30

  if (format.frameRate === 29.97 && format.dropFrame === "df") {
    // Drop frame calculation
    const totalMinutes = tc.hours * 60 + tc.minutes;
    const droppedFrames =
      2 * (totalMinutes - Math.floor(totalMinutes / 10));

    return (
      tc.hours * 108000 +
      tc.minutes * 1800 +
      tc.seconds * 30 +
      tc.frames -
      droppedFrames
    );
  }

  // Non-drop frame (all frame rates)
  return (
    tc.hours * fps * 3600 +
    tc.minutes * fps * 60 +
    tc.seconds * fps +
    tc.frames
  );
}

/**
 * Convert total frame count to TimecodeValue.
 */
export function framesToTimecode(
  totalFrames: number,
  format: TimecodeFormat
): TimecodeValue {
  const fps = Math.round(format.frameRate);

  if (format.frameRate === 29.97 && format.dropFrame === "df") {
    // Drop frame reverse calculation
    const framesPerMinute = 1800 - 2; // 1798
    const framesPer10Min = framesPerMinute * 10 + 2; // 17982

    const d = Math.floor(totalFrames / framesPer10Min);
    const m = totalFrames % framesPer10Min;

    let adjustedFrames = totalFrames;
    if (m > 2) {
      adjustedFrames +=
        2 * Math.floor((m - 2) / framesPerMinute) + 2 * d * 9;
    } else {
      adjustedFrames += 2 * d * 9;
    }

    // Now convert as if NDF at 30fps
    const frames = adjustedFrames % 30;
    const seconds = Math.floor(adjustedFrames / 30) % 60;
    const minutes = Math.floor(adjustedFrames / 1800) % 60;
    const hours = Math.floor(adjustedFrames / 108000);

    return { hours, minutes, seconds, frames };
  }

  // Non-drop frame
  const framesPerSecond = fps;
  const framesPerMinute = fps * 60;
  const framesPerHour = fps * 3600;

  const hours = Math.floor(totalFrames / framesPerHour);
  const remaining = totalFrames % framesPerHour;
  const minutes = Math.floor(remaining / framesPerMinute);
  const remaining2 = remaining % framesPerMinute;
  const seconds = Math.floor(remaining2 / framesPerSecond);
  const frames = remaining2 % framesPerSecond;

  return { hours, minutes, seconds, frames };
}

/**
 * Format TimecodeValue as "HH:MM:SS:FF" (NDF) or "HH:MM:SS;FF" (DF).
 */
export function timecodeToString(
  tc: TimecodeValue,
  dropFrame: boolean
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const separator = dropFrame ? ";" : ":";
  return `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}${separator}${pad(tc.frames)}`;
}

/**
 * Parse "HH:MM:SS:FF" or "HH:MM:SS;FF" to TimecodeValue.
 * Returns null if invalid.
 */
export function parseTimecodeString(str: string): TimecodeValue | null {
  const match = str.match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (!match) return null;

  return {
    hours: parseInt(match[1], 10),
    minutes: parseInt(match[2], 10),
    seconds: parseInt(match[3], 10),
    frames: parseInt(match[4], 10),
  };
}

/**
 * Convert milliseconds to TimecodeValue at a given frame rate.
 */
export function msToTimecode(
  ms: number,
  format: TimecodeFormat
): TimecodeValue {
  const fps = format.frameRate === 29.97 ? 30 : format.frameRate;
  const totalFrames = Math.floor((ms / 1000) * fps);
  return framesToTimecode(totalFrames, { ...format, dropFrame: "ndf" });
}
