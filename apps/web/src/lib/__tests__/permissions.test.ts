import { describe, it, expect } from "vitest";
import {
  ASSIGNABLE_ROLES,
  ROLE_META,
  ROLE_PERMISSIONS,
  getPermissions,
  hasPermission,
  normalizeRole,
  type Permission,
  type Role,
} from "../permissions";

const ALL = ROLE_PERMISSIONS.owner;
const DIRECTOR_ROLES = ["td", "cd", "pd"] as const;

describe("director roles (td/cd/pd)", () => {
  it.each(DIRECTOR_ROLES)("%s passes every permission check admin passes", (role) => {
    for (const permission of ALL) {
      expect(hasPermission(role, permission)).toBe(hasPermission("admin", permission));
    }
  });

  it.each(DIRECTOR_ROLES)("%s cannot delete the organization", (role) => {
    expect(hasPermission(role, "org:delete")).toBe(false);
  });

  it("a permission added to ALL_PERMISSIONS flows to admin and all directors", () => {
    // admin and directors share the same filtered set object — additions
    // to ALL_PERMISSIONS propagate to all four without further edits.
    for (const role of DIRECTOR_ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBe(ROLE_PERMISSIONS.admin);
    }
  });

  it.each(DIRECTOR_ROLES)("%s normalizes to itself", (role) => {
    expect(normalizeRole(role)).toBe(role);
  });

  it("directors are assignable with admin-tier metadata", () => {
    for (const role of DIRECTOR_ROLES) {
      expect(ASSIGNABLE_ROLES).toContain(role);
      expect(ROLE_META[role].tier).toBe("admin");
    }
    expect(ROLE_META.td.label).toBe("Technical Director");
    expect(ROLE_META.cd.label).toBe("Creative Director");
    expect(ROLE_META.pd.label).toBe("Production Director");
  });
});

describe("manager scoping regression (unchanged by director roles)", () => {
  const expectExactPermissions = (role: Role, expected: readonly Permission[]) => {
    expect([...getPermissions(role)].sort()).toEqual([...expected].sort());
  };

  it("tm keeps its scoped permission set", () => {
    expectExactPermissions("tm", [
      "show:view",
      "showboard:view",
      "rundown:view", "rundown:pin_required",
      "cuesheet:view", "cuesheet:add_notes",
      "cuesheet:push_to_checklist",
      "chat:access",
      "checklist:access",
      "incidents:access",
      "timecode:access",
      "lowerthird:view", "lowerthird:trigger", "lowerthird:configure",
      "dashboard:tm",
      "devices:access",
      "streaming_suite:access",
      "stream_health:view", "stream_health:manage",
      "assets:view", "assets:manage",
      "settings:organization",
      "settings:integrations",
      "settings:production_defaults",
      "settings:lowerthird_config",
      "settings:notifications",
    ]);
  });

  it("pm keeps its scoped permission set", () => {
    expectExactPermissions("pm", [
      "show:view", "show:edit",
      "showboard:view", "showboard:edit",
      "rundown:view", "rundown:edit",
      "cuesheet:view", "cuesheet:edit",
      "chat:access",
      "checklist:access",
      "incidents:access",
      "checkin:access",
      "timecode:access",
      "lowerthird:view", "lowerthird:trigger",
      "dashboard:pm",
      "stream_health:view",
      "assets:view",
    ]);
  });

  it("managers never gain admin-tier settings access", () => {
    for (const role of ["pm", "tm", "sm", "member"] as const) {
      expect(hasPermission(role, "settings:members")).toBe(false);
      expect(hasPermission(role, "settings:danger_zone")).toBe(false);
      expect(hasPermission(role, "org:delete")).toBe(false);
    }
  });
});
