import { describe, it, expect } from "vitest";
import {
  ONBOARDING_ARCHETYPES,
  archetypeLanding,
  deriveResumeScene,
  isOnboardingArchetype,
} from "../onboarding-flow";

const base = {
  hasOrg: true,
  isOwner: true,
  started: true,
  hasRole: false,
  hasSeed: false,
  completed: false,
};

describe("deriveResumeScene", () => {
  it("no org → Scene 1", () => {
    expect(deriveResumeScene({ ...base, hasOrg: false })).toEqual({ kind: "scene", scene: 1 });
  });

  it("org created through wizard, no role yet → Scene 2", () => {
    expect(deriveResumeScene(base)).toEqual({ kind: "scene", scene: 2 });
  });

  it("role set, not seeded → Scene 3", () => {
    expect(deriveResumeScene({ ...base, hasRole: true })).toEqual({ kind: "scene", scene: 3 });
  });

  it("seeded (blank counts), not completed → Scene 5", () => {
    expect(deriveResumeScene({ ...base, hasRole: true, hasSeed: true })).toEqual({
      kind: "scene",
      scene: 5,
    });
  });

  it("completed run → redirect (never re-show the wizard)", () => {
    expect(
      deriveResumeScene({ ...base, hasRole: true, hasSeed: true, completed: true }),
    ).toEqual({ kind: "redirect" });
  });

  it("invited (non-owner) members never see the wizard", () => {
    expect(deriveResumeScene({ ...base, isOwner: false })).toEqual({ kind: "redirect" });
  });

  it("orgs created outside the wizard skip it entirely", () => {
    expect(deriveResumeScene({ ...base, started: false })).toEqual({ kind: "redirect" });
  });
});

describe("archetypes", () => {
  it("maps every archetype to its landing route", () => {
    const expected: Record<string, string> = {
      td: "/show",
      pm: "/dashboard/prod-manager",
      sm: "/rundown",
      cd: "/streaming/graphics",
      pastor: "/dashboard/prod-manager",
      op: "/show",
    };
    for (const archetype of ONBOARDING_ARCHETYPES) {
      expect(archetypeLanding(archetype.id)).toBe(expected[archetype.id]);
    }
  });

  it("falls back to /show for unknown archetypes", () => {
    expect(archetypeLanding("unknown")).toBe("/show");
    expect(archetypeLanding(null)).toBe("/show");
  });

  it("recognizes exactly the six archetypes", () => {
    expect(ONBOARDING_ARCHETYPES).toHaveLength(6);
    expect(isOnboardingArchetype("td")).toBe(true);
    expect(isOnboardingArchetype("admin")).toBe(false);
  });
});
