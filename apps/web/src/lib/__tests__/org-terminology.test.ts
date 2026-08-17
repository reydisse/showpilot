import { describe, expect, it } from "vitest";
import { orgTerms, orgTerminologyProfileSchema } from "../org-terminology";

describe("organization terminology", () => {
  it("defaults general production language away from church-specific wording", () => {
    expect(orgTerms("general")).toMatchObject({
      event: "show",
      participate: "work this show",
    });
  });

  it("provides church language only when explicitly selected", () => {
    expect(orgTerms("church")).toMatchObject({
      event: "service",
      participate: "serve",
    });
    expect(orgTerminologyProfileSchema.safeParse("church").success).toBe(true);
    expect(orgTerminologyProfileSchema.safeParse("venue").success).toBe(false);
  });
});
