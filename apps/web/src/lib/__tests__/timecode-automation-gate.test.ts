import { expect, it } from "vitest";
import { isTimecodeGateCommand, sameTimecodeGateReview } from "@showpilot/shared";
const stop = { requestId: "12345678-1234-1234-1234-123456789012", showId: "show", serviceDate: "2026-11-08", operation: "stop" };
const resume = { ...stop, operation: "resume", confirmed: true, expected: { revision: "decision", holdId: null } };
it("accepts Stop and both reviewed resume operations", () => {
  for (const command of [stop, resume, { ...resume, operation: "resume-automatic", expected: { revision: "decision", holdId: "jump" } }]) expect(isTimecodeGateCommand(command)).toBe(true);
});
it.each([null, [], 1, {}, { ...stop, requestId: "invalid" }, { ...stop, showId: "" }, { ...stop, serviceDate: "" }, { ...stop, showId: "x".repeat(201) },
  { ...stop, operation: "toggle" }, { ...resume, confirmed: false }, { ...resume, expected: null }, { ...resume, expected: {} },
  { ...resume, expected: { revision: "decision", holdId: 1 } }, { ...resume, expected: { revision: 1, holdId: null } },
])("rejects malformed automation intent %j", value => { expect(isTimecodeGateCommand(value)).toBe(false); });
it("compares both the decision revision and reviewed jump", () => {
  expect(sameTimecodeGateReview(resume.expected, { ...resume.expected })).toBe(true);
  expect(sameTimecodeGateReview(resume.expected, { ...resume.expected, revision: "new" })).toBe(false);
  expect(sameTimecodeGateReview(resume.expected, { ...resume.expected, holdId: "jump" })).toBe(false);
});
