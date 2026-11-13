import { expect, it } from "vitest";
import { isTimecodeCueControl, isTimecodeCueReview, reviewTimecodeCue, sameTimecodeCueReviews } from "@showpilot/shared";
const cue = { id: "cue", enabled: true, fired: false };
const review = reviewTimecodeCue(cue);
const base = { requestId: "12345678-1234-4234-8234-123456789012", showId: "show", serviceDate: "2026-11-08", expected: [review], confirmed: true, gateRevision: "gate", operation: "remove" };
const clock = { showId: "show", serviceDate: "2026-11-08", frame: 0, format: { frameRate: 30, dropFrame: "ndf" }, incomingFormatId: null };
it.each(["enable", "disable", "remove", "rearm", "reset", "fire", "retry", "refire"])("validates %s with its required review", operation => expect(isTimecodeCueControl({ ...base, operation, clock })).toBe(true));
it.each([null, [], 1, {}, { ...base, requestId: "bad" }, { ...base, showId: "" }, { ...base, serviceDate: "x".repeat(201) },
  { ...base, expected: null }, { ...base, expected: [] }, { ...base, expected: [review, review] },
  { ...base, expected: [review, { ...review, id: "other" }] }, { ...base, operation: "fire", gateRevision: undefined }, { ...base, operation: "fire", gateRevision: "" }, { ...base, operation: "unknown" }, { ...base, confirmed: false },
  { ...base, operation: "reset" }, { ...base, operation: "reset", clock, confirmed: false }, { ...base, expected: [{}] },
])("rejects malformed cue command %j", value => expect(isTimecodeCueControl(value)).toBe(false));
it.each([null, [], {}, { ...review, revision: 1 }, { ...review, executionId: 1 }, { ...review, status: "bad" },
  { ...review, attempts: -1 }, { ...review, attempts: 0.5 }, { ...review, fired: 1 }, { ...review, skipped: 1 }, { ...review, enabled: 1 },
])("rejects malformed execution review %j", value => expect(isTimecodeCueReview(value)).toBe(false));
it("normalizes old cues and captures current attempts", () => {
  expect(review).toEqual({ id: "cue", revision: null, executionId: null, status: "scheduled", attempts: 0, fired: false, skipped: false, enabled: true });
  expect(reviewTimecodeCue({ ...cue, editRevision: "edit", executionId: "execution", executionAttempts: 2, executionStatus: "failed", skipped: true }))
    .toMatchObject({ revision: "edit", executionId: "execution", attempts: 2, status: "failed", skipped: true });
  for (const status of ["dispatching", "acknowledged", "failed"]) expect(isTimecodeCueReview({ ...review, status, revision: "edit", executionId: "execution" })).toBe(true);
});
it("compares the complete set independently of row order", () => {
  const other = { ...review, id: "other" };
  expect(sameTimecodeCueReviews([review, other], [other, review])).toBe(true);
  expect(sameTimecodeCueReviews([review], [])).toBe(false);
  expect(sameTimecodeCueReviews([review], [other])).toBe(false);
});
it.each([{ revision: "new" }, { executionId: "new" }, { status: "failed" as const }, { attempts: 1 }, { fired: true }, { skipped: true }, { enabled: false }])("detects a changed cue %j", changes => expect(sameTimecodeCueReviews([review], [{ ...review, ...changes }])).toBe(false));

it("reviews the entire timeline without clipping larger shows", () => expect(isTimecodeCueControl({ ...base, operation: "reset", clock, expected: Array.from({ length: 5001 }, (_, i) => ({ ...review, id: String(i) })) })).toBe(true));
