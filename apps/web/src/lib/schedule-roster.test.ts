import { expect, it } from "vitest";
import { groupRosterRows, rosterDepartment } from "./schedule-roster";

it("keeps every legacy position exactly once, including blank and padded departments", () => {
  const positions = [
    { id: "legacy", role: "Monitor engineer", department: "" },
    { id: "padded", role: "Projection operator", department: " Video " },
    { id: "explicit", role: "Camera", department: "Special team" },
    { id: "unknown", role: "Stage manager", department: "  " },
  ];
  const groups = groupRosterRows(positions, ["Video", " Video ", "Unused team"]);
  expect(groups.map(group => [group.name, group.rows.map(row => row.id)])).toEqual([
    ["Audio", ["legacy"]], ["Production", ["unknown"]], ["Special team", ["explicit"]], ["Unused team", []], ["Video", ["padded"]],
  ]);
  expect(groups.flatMap(group => group.rows)).toHaveLength(positions.length);
  expect(positions[1].department).toBe(" Video ");
});

it.each([["Audio monitor", "Audio"], ["Camera", "Video"], ["Keys", "Worship"], ["Stage manager", "Production"]])(
  "offers the same inferred %s department used for its row", (role, expected) => {
    const position = { role, department: "" };
    expect(rosterDepartment(position)).toBe(expected);
    expect(groupRosterRows([position], []).map(group => group.name)).toEqual([expected]);
  },
);

it("does not replace a deliberately named department with a role-based guess", () => {
  expect(rosterDepartment({ department: "Tour crew", role: "Camera" })).toBe("Tour crew");
});
