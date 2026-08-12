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

  const value = {
    hours: parseInt(match[1], 10),
    minutes: parseInt(match[2], 10),
    seconds: parseInt(match[3], 10),
    frames: parseInt(match[4], 10),
  };
  if (value.hours < 0 || value.minutes > 59 || value.seconds > 59) return null;
  return value;
}

/** Validate a parsed value against the active SMPTE format. */
export function isValidTimecode(tc: TimecodeValue, format: TimecodeFormat): boolean {
  const nominalFps = Math.round(format.frameRate);
  if (
    !Number.isInteger(tc.hours) || tc.hours < 0 || tc.hours > 23 ||
    !Number.isInteger(tc.minutes) || tc.minutes < 0 || tc.minutes > 59 ||
    !Number.isInteger(tc.seconds) || tc.seconds < 0 || tc.seconds > 59 ||
    !Number.isInteger(tc.frames) || tc.frames < 0 || tc.frames >= nominalFps
  ) return false;

  // At 29.97 DF, labels ;00 and ;01 do not exist at the start of minutes
  // that are not divisible by ten.
  if (
    format.frameRate === 29.97 && format.dropFrame === "df" &&
    tc.seconds === 0 && tc.minutes % 10 !== 0 && tc.frames < 2
  ) return false;
  return true;
}

export function isValidTimecodeFormat(value: unknown): value is TimecodeFormat {
  if (!value || typeof value !== "object") return false;
  const format = value as Partial<TimecodeFormat>;
  if (![24, 25, 29.97, 30].includes(format.frameRate as number)) return false;
  if (format.dropFrame !== "df" && format.dropFrame !== "ndf") return false;
  return format.dropFrame !== "df" || format.frameRate === 29.97;
}

/**
 * Decide whether an event was crossed between relay samples. A 10 Hz relay
 * receives roughly every third frame at 30 fps, so equality/tolerance alone
 * is not reliable enough for show automation.
 */
export function crossedTriggerFrame(
  previousFrame: number | null,
  currentFrame: number,
  triggerFrame: number,
  toleranceFrames = 2,
): boolean {
  if (previousFrame === null || currentFrame < previousFrame) {
    return Math.abs(currentFrame - triggerFrame) <= toleranceFrames;
  }
  return triggerFrame > previousFrame && triggerFrame <= currentFrame;
}

/** Only allow public HTTPS destinations for server-side automation webhooks. */
export function isSafeAutomationWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1") return false;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
    if (ipv4) {
      if (ipv4.some((part) => part > 255)) return false;
      const [a, b] = ipv4;
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    }
    return Boolean(host);
  } catch {
    return false;
  }
}

/**
 * Convert milliseconds to TimecodeValue at a given frame rate.
 */
export function msToTimecode(
  ms: number,
  format: TimecodeFormat
): TimecodeValue {
  const totalFrames = Math.floor((Math.max(0, ms) / 1000) * format.frameRate);
  return framesToTimecode(totalFrames, format);
}
