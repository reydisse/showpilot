import { describe, expect, it } from "vitest";
import { assignmentResponseVersion } from "../assignment-response-version";

const details = {
  showId: "show-1",
  serviceDate: "2026-09-27",
  role: "Camera operator",
  callTime: "08:00",
  effectiveCallTime: "2026-09-27T08:00:00.000Z",
  scheduledStartTime: "2026-09-27T09:00:00.000Z",
};

describe("assignment response version", () => {
  it.each([
    "showId",
    "serviceDate",
    "role",
    "callTime",
    "effectiveCallTime",
    "scheduledStartTime",
  ] as const)("changes when %s changes", (field) => {
    expect(
      assignmentResponseVersion({
        ...details,
        [field]: `${details[field]}-changed`,
      }),
    ).not.toBe(assignmentResponseVersion(details));
  });

  it("is stable for the same reviewed duties", () => {
    expect(assignmentResponseVersion({ ...details })).toBe(
      assignmentResponseVersion(details),
    );
  });
});

it("uses the same reviewed version for D1 numeric, SQL text and ISO timestamps", () => {
  expect(
    assignmentResponseVersion({
      ...details,
      effectiveCallTime: Date.parse(details.effectiveCallTime),
      scheduledStartTime: "2026-09-27 09:00:00",
    }),
  ).toBe(assignmentResponseVersion(details));
});
