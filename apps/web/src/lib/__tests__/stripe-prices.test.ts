import { it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getStripePriceId } from "../stripe.server";

it("keeps monthly working without annual env and resolves configured annual prices", () => {
  const values = env as unknown as Record<string, unknown>;
  for (const plan of ["STARTER", "PRO", "FOUNDING"]) values[`STRIPE_PRICE_${plan}`] = `price_${plan}`;
  for (const plan of ["starter", "pro", "founding"] as const) {
    const key = `STRIPE_PRICE_${plan.toUpperCase()}_ANNUAL`;
    delete values[key];
    expect(getStripePriceId(plan, "monthly")).toBe(`price_${plan.toUpperCase()}`);
    expect(() => getStripePriceId(plan, "annual")).toThrow("Annual billing is not configured for this plan yet");
    values[key] = `annual_${plan}`;
    expect(getStripePriceId(plan, "annual")).toBe(`annual_${plan}`);
    delete values[key];
  }
});
