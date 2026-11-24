import { describe, expect, it } from "vitest";
import { summarizeItems } from "../pm-dashboard";

describe("summarizeItems", () => {
  it.each(["[", "{}", "[null]"])("uses an empty summary for unreadable data %s", (raw) => {
    expect(summarizeItems(raw)).toEqual({
      itemCount: 0,
      missingDuration: 0,
      missingOwner: 0,
      plannedMs: 0,
    });
  });

  it("summarizes valid items and excludes section headers", () => {
    expect(summarizeItems(JSON.stringify([
      { type: "header", duration: 0 },
      { duration: 60_000, assignee: "Audio" },
      { duration: 0, assignee: " " },
    ]))).toEqual({
      itemCount: 2,
      missingDuration: 1,
      missingOwner: 1,
      plannedMs: 60_000,
    });
  });
});
