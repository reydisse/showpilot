import type { Bridge } from "./bridge";

type DesktopTimecodeMessage =
  | { type: "timecode-transport"; state: "stopped" | "waiting" }
  | ({ type: "timecode-feed" } & Parameters<Bridge["feedTimecode"]>[0]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function integer(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** Native stdin is a protocol boundary, including when a sidecar is older. */
export function parseDesktopTimecode(value: unknown, now = Date.now()): DesktopTimecodeMessage | null {
  if (!record(value)) return null;
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 200)) return null;
  if (value.type === "timecode-transport") {
    return value.state === "stopped" || value.state === "waiting" ? { type: value.type, state: value.state } : null;
  }
  if (value.type !== "timecode-feed" || !record(value.timecode) || !record(value.format)) return null;
  if (value.source !== undefined && value.source !== "mtc" && value.source !== "ltc-bridge") return null;
  const source = value.source;
  const { hours, minutes, seconds, frames } = value.timecode;
  const { frameRate, dropFrame } = value.format;
  if (frameRate !== 24 && frameRate !== 25 && frameRate !== 29.97 && frameRate !== 30) return null;
  if (dropFrame !== "df" && dropFrame !== "ndf") return null;
  if (dropFrame === "df" && frameRate !== 29.97) return null;
  if (!integer(hours, 23) || !integer(minutes, 59) || !integer(seconds, 59) || !integer(frames, Math.ceil(frameRate) - 1) || !integer(value.totalFrames, 2_592_000)) return null;
  if (dropFrame === "df" && minutes % 10 !== 0 && seconds === 0 && frames < 2) return null;
  return { type: "timecode-feed", ...(source ? { source } : {}), timecode: { hours, minutes, seconds, frames }, format: { frameRate, dropFrame }, totalFrames: value.totalFrames };
}
