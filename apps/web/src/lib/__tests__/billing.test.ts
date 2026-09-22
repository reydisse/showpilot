import { describe, it, expect } from "vitest";
import {
  PLAN_LIMITS,
  PlanLimitError,
  getEffectivePlan,
  planFromPriceId,
  subscriptionGrantsPaidAccess,
} from "../plan-limits";
import {
  checkoutIdempotencyKey,
  isBlockingSubscriptionStatus,
  reusableCheckoutSession,
} from "../checkout";

const NOW = new Date("2026-06-10T12:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date("2026-12-01T00:00:00Z");

function org(overrides: Partial<{ plan: string; trialEndsAt: Date | null; betaTester: boolean; subscriptionStatus: string | null }> = {}) {
  return { plan: "free", trialEndsAt: null, betaTester: false, subscriptionStatus: null, ...overrides };
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

  it.each([
    ["active", "pro"],
    ["trialing", "pro"],
    ["past_due", "pro"],
    ["unpaid", "free"],
    ["incomplete", "free"],
    ["incomplete_expired", "free"],
    ["paused", "free"],
    ["canceled", "free"],
  ])("applies the paid entitlement policy for %s", (subscriptionStatus, expected) => {
    expect(getEffectivePlan(org({ plan: "pro", subscriptionStatus }), PAST, NOW)).toBe(expected);
  });

  it("does not let Stripe status remove an active ShowPilot trial", () => {
    expect(getEffectivePlan(org({ plan: "pro", subscriptionStatus: "unpaid", trialEndsAt: FUTURE }), PAST, NOW)).toBe("pro");
  });
});

describe("checkout concurrency guards", () => {
  it("treats every non-terminal subscription as an existing billing operation", () => {
    expect(isBlockingSubscriptionStatus("active")).toBe(true);
    expect(isBlockingSubscriptionStatus("incomplete")).toBe(true);
    expect(isBlockingSubscriptionStatus("canceled")).toBe(false);
    expect(isBlockingSubscriptionStatus("incomplete_expired")).toBe(false);
  });

  it("reuses only the same organization's matching open checkout", () => {
    const matching = {
      id: "cs_match",
      status: "open",
      mode: "subscription",
      metadata: { orgId: "org-1", plan: "pro", uiMode: "hosted" },
    };
    const sessions = [
      { ...matching, id: "cs_other", metadata: { ...matching.metadata, plan: "starter" } },
      matching,
    ];
    expect(reusableCheckoutSession(sessions as never, { orgId: "org-1", plan: "pro", uiMode: "hosted" })?.id).toBe("cs_match");
  });

  it("uses one deterministic operation key for same-day retries", () => {
    const first = checkoutIdempotencyKey("org-1", "pro", "hosted", NOW);
    expect(checkoutIdempotencyKey("org-1", "pro", "hosted", NOW)).toBe(first);
    expect(checkoutIdempotencyKey("org-1", "starter", "hosted", NOW)).not.toBe(first);
  });

  it("documents the paid status allowlist", () => {
    expect(subscriptionGrantsPaidAccess(null)).toBe(true);
    expect(subscriptionGrantsPaidAccess("past_due")).toBe(true);
    expect(subscriptionGrantsPaidAccess("unpaid")).toBe(false);
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
