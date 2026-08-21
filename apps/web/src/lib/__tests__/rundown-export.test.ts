import { describe, expect, it } from "vitest";
import { buildRundownCsv, type ExportReport } from "@/lib/rundown-export";

const report: ExportReport = {
  generatedAt: "2026-08-21T12:00:00.000Z",
  serviceDate: "2026-08-23",
  organization: { id: "org-1", name: "Test Venue", slug: "test-venue" },
  summary: { totalItems: 1, completedItems: 0, plannedDurationMs: 60_000, elapsedMs: 0 },
  rundown: {
    name: "Sunday Show",
    stageMessage: "",
    items: [{
      id: "item-1",
      title: 'Welcome, "everyone"',
      type: "segment",
      duration: 60_000,
      notes: "Opening",
      assignee: "Alex",
      cue: "GO",
      status: "upcoming",
      sortOrder: 0,
      hardStop: false,
    }],
  },
  incidents: [{
    id: "incident-1",
    category: "Audio",
    severity: "low",
    description: "Mic pop",
    reportedBy: "Sam",
    timestamp: "2026-08-21T11:00:00.000Z",
  }],
  checklist: [{ label: "Batteries", category: "Audio", checked: true, checkedBy: "Sam" }],
  crew: [{ role: "Stage Manager", name: "Jo", status: "checked-in", notes: "" }],
  cueSheets: [{ cueNumber: 1, rundownItem: "Welcome", cameraAssignments: "Cam 1", notes: "Wide" }],
};

describe("buildRundownCsv", () => {
  it("produces one rectangular 22-column table for every report section", () => {
    const rows = buildRundownCsv(report).split("\r\n");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      let columns = 1;
      let quoted = false;
      for (let index = 0; index < row.length; index += 1) {
        if (row[index] === '"') {
          if (quoted && row[index + 1] === '"') index += 1;
          else quoted = !quoted;
        } else if (row[index] === "," && !quoted) {
          columns += 1;
        }
      }
      expect(quoted).toBe(false);
      expect(columns).toBe(22);
    }
  });

  it("escapes commas and quotes in text fields", () => {
    expect(buildRundownCsv(report)).toContain('"Welcome, ""everyone"""');
  });
});
