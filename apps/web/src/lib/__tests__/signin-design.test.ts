import { describe, expect, it } from "vitest";
import { getSignInDesign } from "../signin-design";

describe("monthly sign-in artwork", () => {
  it("starts with Rhythm, rotates at UTC month boundaries, and repeats across years", () => {
    expect(getSignInDesign(new Date("2026-10-01T00:00:00Z"))).toBe("rhythm");
    expect(getSignInDesign(new Date("2026-10-31T23:59:59.999Z"))).toBe(
      "rhythm",
    );
    expect(getSignInDesign(new Date("2026-11-01T00:00:00Z"))).toBe("afterglow");
    expect(getSignInDesign(new Date("2026-12-01T00:00:00Z"))).toBe("in-sync");
    expect(getSignInDesign(new Date("2027-01-01T00:00:00Z"))).toBe("rhythm");
    expect(getSignInDesign(new Date("2027-10-01T00:00:00Z"))).toBe("rhythm");
  });
  it("uses the same month regardless of the visitor's offset", () => {
    expect(getSignInDesign(new Date("2026-10-31T20:00:00-04:00"))).toBe(
      "afterglow",
    );
    expect(getSignInDesign(new Date("2026-11-01T01:00:00+02:00"))).toBe(
      "rhythm",
    );
  });
});
