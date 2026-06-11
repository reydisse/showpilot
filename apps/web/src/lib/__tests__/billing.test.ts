import { describe, it, expect } from "vitest";
import {
  PLAN_LIMITS,
  PlanLimitError,
  getEffectivePlan,
  planFromPriceId,
} from "../plan-limits";

const NOW = new Date("2026-06-10T12:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date("2026-12-01T00:00:00Z");

function org(overrides: Partial<{ plan: string; trialEndsAt: Date | null; betaTester: boolean }> = {}) {
  return { plan: "free", trialEndsAt: null, betaTester: false, ...overrides };
}

describe("getEffectivePlan precedence", () => {
  it("beta tester before launch → pro", () => {
    expect(getEffectivePlan(org({ betaTester: true }), FUTURE, NOW)).toBe("pro");
  });

  it("beta tester with launch date unset → pro (beta access stays open)", () => {
    expect(getEffectivePlan(org({ betaTester: true }), null, NOW)).toBe("pro");
  });

  it("beta tester after launch → free", () => {
    expect(getEffectivePlan(org({ betaTester: true }), PAST, NOW)).toBe("free");
  });

  it("beta + active trial after launch → pro until trial end", () => {
    expect(
      getEffectivePlan(org({ betaTester: true, trialEndsAt: FUTURE }), PAST, NOW),
    ).toBe("pro");
  });

  it("expired trial → falls back to stored plan", () => {
    expect(getEffectivePlan(org({ trialEndsAt: PAST }), null, NOW)).toBe("free");
  });

  it("active trial → pro regardless of stored plan", () => {
    expect(getEffectivePlan(org({ trialEndsAt: FUTURE }), null, NOW)).toBe("pro");
  });

  it("paid plan always wins over expired beta", () => {
    expect(
      getEffectivePlan(org({ plan: "starter", betaTester: true }), PAST, NOW),
    ).toBe("starter");
    expect(
      getEffectivePlan(org({ plan: "pro", betaTester: true }), PAST, NOW),
    ).toBe("pro");
  });

  it("unknown stored plan coerces to free", () => {
    expect(getEffectivePlan(org({ plan: "enterprise" }), null, NOW)).toBe("free");
  });
});

describe("planFromPriceId", () => {
  const prices = { starter: "price_st", pro: "price_pro", founding: "price_fnd" };

  it("maps each price to its plan", () => {
    expect(planFromPriceId("price_st", prices)).toEqual({ plan: "starter", foundingMember: false });
    expect(planFromPriceId("price_pro", prices)).toEqual({ plan: "pro", foundingMember: false });
  });

  it("founding price grants pro + foundingMember", () => {
    expect(planFromPriceId("price_fnd", prices)).toEqual({ plan: "pro", foundingMember: true });
  });

  it("unknown price → null", () => {
    expect(planFromPriceId("price_other", prices)).toBeNull();
  });
});

describe("plan limits shape", () => {
  it("free plan excludes integrations and kiosk", () => {
    expect(PLAN_LIMITS.free.integrations).toBe(false);
    expect(PLAN_LIMITS.free.kiosk).toBe(false);
  });

  it("paid plans include integrations and kiosk", () => {
    expect(PLAN_LIMITS.starter.integrations).toBe(true);
    expect(PLAN_LIMITS.pro.kiosk).toBe(true);
  });

  it("PlanLimitError carries a 402 status", () => {
    const err = new PlanLimitError("over the cap");
    expect(err.status).toBe(402);
    expect(err.name).toBe("PlanLimitError");
  });
});
