import { describe, it, expect } from "vitest";
import {
  buildCheckoutSessionParams,
  resolveCheckoutUiMode,
} from "../checkout";

describe("resolveCheckoutUiMode — fallback decision", () => {
  it("uses embedded checkout when a publishable key is configured", () => {
    expect(resolveCheckoutUiMode("pk_test_abc123")).toBe("embedded");
    expect(resolveCheckoutUiMode("pk_live_abc123")).toBe("embedded");
    expect(resolveCheckoutUiMode("  pk_live_abc123  ")).toBe("embedded");
  });

  it("degrades to the hosted flow when the key is missing or blank", () => {
    expect(resolveCheckoutUiMode(undefined)).toBe("hosted");
    expect(resolveCheckoutUiMode(null)).toBe("hosted");
    expect(resolveCheckoutUiMode("")).toBe("hosted");
    expect(resolveCheckoutUiMode("   ")).toBe("hosted");
  });

  it("degrades to hosted when the value is clearly not a publishable key", () => {
    expect(resolveCheckoutUiMode("sk_live_oops")).toBe("hosted");
    expect(resolveCheckoutUiMode("not-a-key")).toBe("hosted");
  });
});

const input = {
  customerId: "cus_123",
  orgId: "org_123",
  orgSlug: "grace",
  priceId: "price_abc",
  baseUrl: "https://showpilot.tech",
};

describe("buildCheckoutSessionParams — session mode selection", () => {
  it("embedded sessions use ui_mode + return_url and no hosted redirect URLs", () => {
    const params = buildCheckoutSessionParams({ ...input, uiMode: "embedded" });
    expect(params.ui_mode).toBe("embedded_page");
    expect(params.return_url).toBe("https://showpilot.tech/grace/settings?billing=success");
    expect(params.success_url).toBeUndefined();
    expect(params.cancel_url).toBeUndefined();
  });

  it("hosted sessions use success/cancel URLs and no embedded fields", () => {
    const params = buildCheckoutSessionParams({ ...input, uiMode: "hosted" });
    expect(params.ui_mode).toBeUndefined();
    expect(params.return_url).toBeUndefined();
    expect(params.success_url).toBe("https://showpilot.tech/grace/settings?billing=success");
    expect(params.cancel_url).toBe("https://showpilot.tech/grace/settings?billing=cancelled");
  });

  it("the subscription payload is identical in both modes (webhook unchanged)", () => {
    const embedded = buildCheckoutSessionParams({ ...input, uiMode: "embedded" });
    const hosted = buildCheckoutSessionParams({ ...input, uiMode: "hosted" });
    for (const key of ["mode", "customer", "client_reference_id", "line_items", "subscription_data"] as const) {
      expect(embedded[key]).toEqual(hosted[key]);
    }
    expect(embedded.subscription_data?.metadata?.orgId).toBe("org_123");
  });
});
