import { isTimecodeClockReview, type TimecodeClockReview } from "./timecode-clock-edit";
export type TimecodeCueReview = { id: string; revision: string | null; executionId: string | null;
  status: "scheduled" | "dispatching" | "acknowledged" | "failed"; attempts: number; fired: boolean; skipped: boolean; enabled: boolean };
export type TimecodeCueOperation = "enable" | "disable" | "remove" | "rearm" | "reset" | "fire" | "retry" | "refire";
export type TimecodeCueControl = { requestId: string; showId: string; serviceDate: string; expected: TimecodeCueReview[] } & (
  | { operation: "enable" | "disable" }
  | { operation: "remove" | "rearm"; confirmed: true }
  | { operation: "fire" | "retry" | "refire"; confirmed: true; gateRevision: string }
  | { operation: "reset"; confirmed: true; clock: TimecodeClockReview }
);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
export function isTimecodeCueReview(value: unknown): value is TimecodeCueReview {
  return record(value) && text(value.id) && (value.revision === null || text(value.revision)) && (value.executionId === null || text(value.executionId))
    && (value.status === "scheduled" || value.status === "dispatching" || value.status === "acknowledged" || value.status === "failed")
    && typeof value.attempts === "number" && Number.isSafeInteger(value.attempts) && value.attempts >= 0
    && typeof value.fired === "boolean" && typeof value.skipped === "boolean" && typeof value.enabled === "boolean";
}
export function isTimecodeCueControl(value: unknown): value is TimecodeCueControl {
  if (!record(value) || typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId)
    || !text(value.showId) || !text(value.serviceDate) || !Array.isArray(value.expected) || !value.expected.length
    || !value.expected.every(isTimecodeCueReview) || new Set(value.expected.map(item => item.id)).size !== value.expected.length) return false;
  if (value.operation === "reset") return value.confirmed === true && isTimecodeClockReview(value.clock);
  if (value.expected.length !== 1) return false;
  if (value.operation === "enable" || value.operation === "disable") return true;
  if (value.confirmed !== true) return false;
  return value.operation === "remove" || value.operation === "rearm"
    || ((value.operation === "fire" || value.operation === "retry" || value.operation === "refire") && text(value.gateRevision));
}
export function reviewTimecodeCue(event: { id: string; editRevision?: string; executionId?: string; executionStatus?: TimecodeCueReview["status"];
  executionAttempts?: number; fired: boolean; skipped?: boolean; enabled: boolean }): TimecodeCueReview {
  return { id: event.id, revision: event.editRevision ?? null, executionId: event.executionId ?? null,
    status: event.executionStatus ?? "scheduled", attempts: event.executionAttempts ?? 0, fired: event.fired, skipped: event.skipped === true, enabled: event.enabled };
}
export function sameTimecodeCueReviews(a: TimecodeCueReview[], b: TimecodeCueReview[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map(item => [item.id, item]));
  return a.every(item => {
    const other = byId.get(item.id);
    return other && item.revision === other.revision && item.executionId === other.executionId && item.status === other.status
      && item.attempts === other.attempts && item.fired === other.fired && item.skipped === other.skipped && item.enabled === other.enabled;
  });
}
