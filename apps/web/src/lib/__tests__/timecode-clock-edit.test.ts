import { expect, it } from "vitest";
import { isReviewedTimecodeClockEdit, isTimecodeClockReview } from "@showpilot/shared";
import { prepareTimecodeClockEdit } from "../timecode-clock-edit";
import type { TimecodeState } from "@/types/timecode";
const state: TimecodeState = {
  showId: "show", serviceDate: "2026-11-08", timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
  display: "00:00:00:00", totalFrames: 0, running: false, triggersEnabled: true, source: "internal-freerun",
  format: { frameRate: 30, dropFrame: "ndf" }, lyrics: null, serverTime: 100,
};
const expected = { showId: "show", serviceDate: "2026-11-08", frame: 0, format: state.format, incomingFormatId: null };
const edit = { kind: "seek", requestId: "e7a6401e-2f53-4c85-93d1-4f139af1041f", confirmed: true, expected, timecode: state.timecode };
it.each([null, undefined, [], "seek", { ...edit, requestId: "invalid" }, { ...edit, confirmed: false },
  { ...edit, kind: "unknown" }, { ...edit, expected: null }, { ...edit, timecode: null },
  { ...edit, timecode: { ...state.timecode, frames: "0" } }, { ...edit, timecode: { ...state.timecode, hours: 24 } },
  { ...edit, kind: "reformat", format: { frameRate: 60, dropFrame: "ndf" } },
])("rejects a malformed reviewed clock edit %j", value => expect(isReviewedTimecodeClockEdit(value)).toBe(false));
it.each([{ ...expected, showId: "" }, { ...expected, serviceDate: "" }, { ...expected, frame: -1 },
  { ...expected, frame: Infinity }, { ...expected, frame: 0.5 }, { ...expected, format: {} },
  { ...expected, incomingFormatId: 12 }, { ...expected, incomingFormatId: "" },
])("rejects malformed review metadata %j", value => expect(isTimecodeClockReview(value)).toBe(false));
it("accepts a reviewed input format and valid drop-frame position", () => {
  const format = { frameRate: 29.97, dropFrame: "df" };
  expect(isReviewedTimecodeClockEdit({ ...edit, expected: { ...expected, format, incomingFormatId: "input-1" },
    timecode: { hours: 0, minutes: 1, seconds: 0, frames: 2 } })).toBe(true);
  expect(isReviewedTimecodeClockEdit({ ...edit, kind: "reformat", format })).toBe(true);
});
it.each([undefined, {}, { timecode: "invalid" }, { timecode: {} },
  { timecode: { ...state.timecode, frames: "1" } }, { timecode: { ...state.timecode, frames: 30 } },
])("keeps the clock unchanged for invalid legacy seek payloads %j", payload => {
  expect(prepareTimecodeClockEdit(state, [], "set-timecode", payload)).toBeNull();
  expect(state.totalFrames).toBe(0);
});
it("stages a small seek without mutating the current clock or adding a review hold", () => {
  const next = prepareTimecodeClockEdit(state, [], "set-timecode", { timecode: { ...state.timecode, frames: 1 } });
  expect(next?.state).toMatchObject({ totalFrames: 1, triggersEnabled: true });
  expect(next?.state.automationHold).toBeUndefined();
  expect(state.totalFrames).toBe(0);
});
it("rejects an obsolete input proposal while keeping the current clock intact", () => {
  const incoming = { ...state, incomingFormat: { id: "new-input", format: { frameRate: 25 as const, dropFrame: "ndf" as const } } };
  expect(() => prepareTimecodeClockEdit(incoming, [], "set-format", { format: incoming.incomingFormat.format,
    expectedFormat: state.format, expectedIncomingFormatId: "old-input", confirmed: true })).toThrow("input format changed");
  expect(state.format.frameRate).toBe(30);
});
