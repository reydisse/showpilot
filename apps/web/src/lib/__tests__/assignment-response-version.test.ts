import { describe, expect, it } from "vitest";
import { assignmentResponseVersion } from "../assignment-response-version";

const details = {
  showId: "show-1",
  serviceDate: "2026-09-27",
  role: "Camera operator",
  callTime: "08:00",
  scheduledStartTime: "2026-09-27T09:00:00.000Z",
};

describe("assignment response version", () => {
  it.each(["showId", "serviceDate", "role", "callTime", "scheduledStartTime"] as const)(
    "changes when %s changes",
    (field) => {
      expect(assignmentResponseVersion({ ...details, [field]: `${details[field]}-changed` }))
        .not.toBe(assignmentResponseVersion(details));
    },
  );

  it("is stable for the same reviewed duties", () => {
    expect(assignmentResponseVersion({ ...details })).toBe(assignmentResponseVersion(details));
  });
});
