// @vitest-environment node
import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentSubscriptionId: "sub_old" as string | null,
  plan: "pro",
  status: "active",
  update: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getPrisma: () => ({
    organization: {
      findFirst: vi.fn(async ({ where }: { where: { stripeSubscriptionId: string } }) =>
        mocks.currentSubscriptionId === where.stripeSubscriptionId ? { id: "org-1" } : null),
      update: mocks.update,
      updateMany: vi.fn(async ({ where, data }: {
        where: { stripeSubscriptionId: string };
        data: { plan: string; stripeSubscriptionId: null; subscriptionStatus: string };
      }) => {
        if (mocks.currentSubscriptionId !== where.stripeSubscriptionId) return { count: 0 };
        mocks.currentSubscriptionId = data.stripeSubscriptionId;
        mocks.plan = data.plan;
        mocks.status = data.subscriptionStatus;
        return { count: 1 };
      }),
    },
  }),
}));

import {
  handleSubscriptionDeleted,
  handleSubscriptionUpdated,
} from "@/routes/api/stripe/webhook";

const prices = { starter: "price_starter", pro: "price_pro", founding: "price_founding" };

function subscription(id: string, status: Stripe.Subscription.Status): Stripe.Subscription {
  return {
    id,
    status,
    customer: "cus_1",
    items: { data: [{ price: { id: "price_pro" } }] },
  } as Stripe.Subscription;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentSubscriptionId = "sub_old";
  mocks.plan = "pro";
  mocks.status = "active";
});

describe("Stripe webhook resource ordering", () => {
  it("does not let a delayed update reclaim a canceled subscription", async () => {
    const oldSubscription = subscription("sub_old", "active");

    await handleSubscriptionDeleted(oldSubscription);
    expect(mocks.currentSubscriptionId).toBeNull();
    expect(mocks.plan).toBe("free");

    await handleSubscriptionUpdated(oldSubscription, prices);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.currentSubscriptionId).toBeNull();
    expect(mocks.plan).toBe("free");
  });

  it("ignores updates from an old subscription after replacement", async () => {
    mocks.currentSubscriptionId = "sub_new";
    await handleSubscriptionUpdated(subscription("sub_old", "active"), prices);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("applies duplicate updates only to the currently owned subscription", async () => {
    await handleSubscriptionUpdated(subscription("sub_old", "past_due"), prices);
    await handleSubscriptionUpdated(subscription("sub_old", "past_due"), prices);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "org-1" },
      data: expect.objectContaining({ stripeSubscriptionId: "sub_old", subscriptionStatus: "past_due" }),
    }));
  });
});
