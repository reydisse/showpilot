import { describe, expect, it } from "vitest";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
  equipmentCategoryLabel,
  equipmentStatusLabel,
} from "@showpilot/shared";

describe("equipment vocabulary", () => {
  it("includes every value accepted by web and native asset editors", () => {
    expect(EQUIPMENT_CATEGORIES).toEqual([
      "audio",
      "video",
      "lighting",
      "streaming",
      "network",
      "power",
      "cables",
      "comms",
      "other",
    ]);
    expect(EQUIPMENT_STATUSES).toEqual([
      "operational",
      "maintenance",
      "needs-repair",
      "in-repair",
      "broken",
      "out-of-service",
      "retired",
    ]);
  });

  it("labels unknown legacy values honestly", () => {
    expect(equipmentCategoryLabel("legacy-rack")).toBe("Unknown (legacy-rack)");
    expect(equipmentStatusLabel("maybe")).toBe("Unknown (maybe)");
  });
});
