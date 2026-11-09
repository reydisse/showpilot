import { isValidTimecode, isValidTimecodeFormat, type TimecodeFormat, type TimecodeValue } from "./timecode-validation";

export type TimecodeClockReview = {
  showId: string;
  serviceDate: string;
  frame: number;
  format: TimecodeFormat;
  incomingFormatId: string | null;
};
export type ReviewedTimecodeClockEdit = {
  requestId: string;
  expected: TimecodeClockReview;
  confirmed: true;
} & ({ kind: "seek"; timecode: TimecodeValue } | { kind: "reformat"; format: TimecodeFormat });

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
export function isTimecodeClockReview(value: unknown): value is TimecodeClockReview {
  return record(value) && text(value.showId) && text(value.serviceDate)
    && typeof value.frame === "number" && Number.isSafeInteger(value.frame) && value.frame >= 0
    && isValidTimecodeFormat(value.format) && (value.incomingFormatId === null || text(value.incomingFormatId));
}
export function isReviewedTimecodeClockEdit(value: unknown): value is ReviewedTimecodeClockEdit {
  if (!record(value) || typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId)
    || value.confirmed !== true || !isTimecodeClockReview(value.expected)) return false;
  if (value.kind === "reformat") return isValidTimecodeFormat(value.format);
  if (value.kind !== "seek" || !record(value.timecode)) return false;
  const { hours, minutes, seconds, frames } = value.timecode;
  return typeof hours === "number" && typeof minutes === "number" && typeof seconds === "number" && typeof frames === "number"
    && isValidTimecode({ hours, minutes, seconds, frames }, value.expected.format);
}
export function sameTimecodeClockReview(a: TimecodeClockReview, b: TimecodeClockReview): boolean {
  return a.showId === b.showId && a.serviceDate === b.serviceDate && a.frame === b.frame
    && a.format.frameRate === b.format.frameRate && a.format.dropFrame === b.format.dropFrame
    && a.incomingFormatId === b.incomingFormatId;
}
