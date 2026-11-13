export type TimecodeFormat = { frameRate: 24 | 25 | 29.97 | 30; dropFrame: "df" | "ndf" };
export type TimecodeValue = { hours: number; minutes: number; seconds: number; frames: number };

/**
 * Parse "HH:MM:SS:FF" or "HH:MM:SS;FF" to TimecodeValue.
 * Validate labels against the selected rate and drop-frame rules.
 * Both separators are accepted; the selected format determines valid labels.
 */
export function parseTimecodeString(str: string, format: TimecodeFormat): TimecodeValue | null {
  const match = str.match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (!match) return null;

  const value = {
    hours: parseInt(match[1], 10),
    minutes: parseInt(match[2], 10),
    seconds: parseInt(match[3], 10),
    frames: parseInt(match[4], 10),
  };
  return isValidTimecodeFormat(format) && isValidTimecode(value, format) ? value : null;
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
  if (!("frameRate" in value) || !("dropFrame" in value)) return false;
  if (value.frameRate !== 24 && value.frameRate !== 25 && value.frameRate !== 29.97 && value.frameRate !== 30) return false;
  if (value.dropFrame !== "df" && value.dropFrame !== "ndf") return false;
  return value.dropFrame !== "df" || value.frameRate === 29.97;
}

