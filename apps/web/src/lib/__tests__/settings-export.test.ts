import { describe, expect, it } from "vitest";
import { REPORT_EXPORT_SECTIONS, selectReportExportSections } from "../settings-export";

describe("Settings show-report export sections", () => {
  it("offers and retains crew and manager notes", () => {
    expect(REPORT_EXPORT_SECTIONS.map(([key]) => key)).toContain("crew");
    expect(REPORT_EXPORT_SECTIONS.map(([key]) => key)).toContain("managerNotes");

    const report = {
      generatedAt: "2026-09-21T00:00:00Z",
      serviceDate: "2026-09-21",
      organization: { id: "org", name: "Faithfire", slug: "faithfire" },
      summary: {},
      rundown: {},
      incidents: [],
      checklist: [],
      cueSheets: [],
      crew: [{ role: "PM", name: "Alex", status: "accepted", notes: "Ready" }],
      managerNotes: [{ id: "note", summary: "Strong handoff" }],
      viewer: { userId: "user", writableNoteLanes: [] },
    };

    const selected = selectReportExportSections(
      report as never,
      ["crew", "managerNotes"],
    );
    expect(selected).toMatchObject({ crew: report.crew, managerNotes: report.managerNotes });
    expect(selected).not.toHaveProperty("rundown");
  });
});
