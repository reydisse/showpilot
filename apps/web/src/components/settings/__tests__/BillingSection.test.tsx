import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BillingSection } from "../BillingSection";
import type { OrgBillingInfo } from "@/lib/billing";

vi.mock("@/lib/billing", () => ({
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
}));
afterEach(cleanup);
const billing: OrgBillingInfo = {
  plan: "free",
  effectivePlan: "pro",
  subscriptionStatus: null,
  trialEndsAt: "2099-01-01T00:00:00.000Z",
  foundingMember: false,
  betaTester: false,
  publicLaunchDate: null,
  foundingEligible: true,
  hasStripeCustomer: false,
};
it("distinguishes a Free plan with temporary Pro access from a Pro subscription", () => {
  render(<BillingSection orgId="fixture" billing={billing} />);
  expect(screen.getByText("Current plan: Free")).toBeTruthy();
  expect(screen.getByText(/Pro trial access/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Subscribe to Pro" })).toBeTruthy();
});
it("marks only Founding current, including when the acquisition offer has closed", () => {
  render(
    <BillingSection
      orgId="fixture"
      billing={{
        ...billing,
        plan: "pro",
        trialEndsAt: null,
        foundingMember: true,
        foundingEligible: false,
      }}
    />,
  );
  const current = screen.getAllByText("Current plan");
  expect(current).toHaveLength(1);
  expect(
    within(screen.getByRole("group", { name: "Founding plan" })).getByText(
      "Current plan",
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Subscribe to Pro" })).toBeTruthy();
});
it.each(["starter", "pro"])("marks only the saved %s plan current", (plan) => {
  render(
    <BillingSection
      orgId="fixture"
      billing={{ ...billing, plan, trialEndsAt: null }}
    />,
  );
  expect(screen.getAllByText("Current plan")).toHaveLength(1);
  expect(
    screen.getByText(`Current plan: ${plan === "pro" ? "Pro" : "Starter"}`),
  ).toBeTruthy();
});
it("does not present an unpaid subscription as current paid access", () => {
  render(
    <BillingSection
      orgId="fixture"
      billing={{
        ...billing,
        plan: "pro",
        effectivePlan: "free",
        subscriptionStatus: "unpaid",
        trialEndsAt: null,
        hasStripeCustomer: true,
      }}
    />,
  );
  expect(screen.getByText("Current plan: Free")).toBeTruthy();
  expect(
    screen.getByText(/saved Pro subscription is not providing paid access/),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Manage billing" })).toBeTruthy();
  expect(screen.queryByText("Current plan")).toBeNull();
});
it("keeps beta feature access separate from the plan and does not offer a second founding purchase", () => {
  render(
    <BillingSection
      orgId="fixture"
      billing={{
        ...billing,
        plan: "pro",
        foundingMember: true,
        betaTester: true,
        publicLaunchDate: "2099-01-01T00:00:00.000Z",
      }}
    />,
  );
  expect(screen.getByText("Current plan: Founding")).toBeTruthy();
  expect(
    screen.getByText("Pro beta access is free until public launch."),
  ).toBeTruthy();
  expect(screen.queryByText(/Pro trial access/)).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Subscribe to Founding/ }),
  ).toBeNull();
});
it("does not label an expired trial as active or hide Free", () => {
  render(
    <BillingSection
      orgId="fixture"
      billing={{
        ...billing,
        effectivePlan: "free",
        trialEndsAt: "2000-01-01T00:00:00.000Z",
      }}
    />,
  );
  expect(screen.getByText("Current plan: Free")).toBeTruthy();
  expect(screen.queryByText(/Pro trial access/)).toBeNull();
  expect(screen.getByText("Features available now: Free")).toBeTruthy();
});
