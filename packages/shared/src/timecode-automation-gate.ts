export type TimecodeGateReview = { revision: string; holdId: string | null };
export type TimecodeGateCommand = { requestId: string; showId: string; serviceDate: string } & (
  | { operation: "stop" }
  | { operation: "resume" | "resume-automatic"; confirmed: true; expected: TimecodeGateReview }
);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
export function isTimecodeGateCommand(value: unknown): value is TimecodeGateCommand {
  if (!record(value) || !text(value.requestId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId)
    || !text(value.showId) || !text(value.serviceDate)) return false;
  if (value.operation === "stop") return true;
  return (value.operation === "resume" || value.operation === "resume-automatic") && value.confirmed === true
    && record(value.expected) && text(value.expected.revision) && (value.expected.holdId === null || text(value.expected.holdId));
}
export function sameTimecodeGateReview(a: TimecodeGateReview, b: TimecodeGateReview): boolean {
  return a.revision === b.revision && a.holdId === b.holdId;
}
