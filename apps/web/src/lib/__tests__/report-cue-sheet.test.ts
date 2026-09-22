import { describe, expect, it } from "vitest";
import { buildReportCueRows } from "../report-cue-sheet";
import type { RundownItem } from "@/types/rundown";

const items: RundownItem[] = [
  {
    id: "header",
    title: "Worship",
    type: "header",
    duration: 0,
    notes: "",
    assignee: "",
    cue: "",
    status: "upcoming",
    sortOrder: 0,
    hardStop: false,
  },
  {
    id: "welcome",
    title: "Welcome",
    type: "segment",
    duration: 60_000,
    notes: "Host enters from stage left",
    assignee: "",
    cue: "",
    status: "upcoming",
    sortOrder: 1,
    hardStop: false,
  },
];

describe("buildReportCueRows", () => {
  it("exports current department notes in column order", () => {
    expect(
      buildReportCueRows(
        items,
        [
          { id: "lx", label: "LX", sortOrder: 2 },
          { id: "production", label: "Production", sortOrder: 1 },
        ],
        [
          { itemId: "welcome", columnId: "lx", text: "  Fade house  " },
          { itemId: "welcome", columnId: "production", text: "Take camera 2" },
          { itemId: "welcome", columnId: "missing", text: "Do not leak this" },
        ],
      ),
    ).toEqual([
      {
        id: "cue-report:welcome",
        cueNumber: 1,
        rundownItem: "Welcome",
        cameraAssignments: "Production: Take camera 2\nLX: Fade house",
        notes: "Host enters from stage left",
      },
    ]);
  });
});
