import type Stripe from "stripe";

// Pure checkout-flow decisions, shared by the billing server functions and
// the settings UI, and unit-tested without Workers imports.

export type CheckoutUiMode = "embedded" | "hosted";

/**
 * Decide which checkout flow the client can run. Embedded Checkout needs the
 * build-time publishable key; anything else (missing, blank, or a value that
 * is clearly not a publishable key) degrades to the working hosted flow so a
 * missing var never breaks checkout.
 */
export function resolveCheckoutUiMode(
  publishableKey: string | null | undefined,
): CheckoutUiMode {
  const key = publishableKey?.trim();
  return key && key.startsWith("pk_") ? "embedded" : "hosted";
}

/** Read the build-time publishable key (set via VITE_STRIPE_PUBLISHABLE_KEY). */
export function getStripePublishableKey(): string | undefined {
  const env =
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return env.VITE_STRIPE_PUBLISHABLE_KEY;
}

export interface CheckoutSessionParamsInput {
  uiMode: CheckoutUiMode;
  customerId: string;
  orgId: string;
  orgSlug: string;
  priceId: string;
  baseUrl: string;
}

/**
 * Build the Stripe Checkout Session params for either flow. Embedded sessions
 * use ui_mode + return_url; hosted sessions use success_url/cancel_url. The
 * subscription payload is identical, so the webhook is unaffected.
 */
export function buildCheckoutSessionParams(
  input: CheckoutSessionParamsInput,
): Stripe.Checkout.SessionCreateParams {
  const base: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    customer: input.customerId,
    client_reference_id: input.orgId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    subscription_data: { metadata: { orgId: input.orgId } },
  };

  if (input.uiMode === "embedded") {
    return {
      ...base,
      // "embedded_page" is stripe-node v22's name for embedded Checkout
      // (formerly ui_mode: "embedded") — the client_secret it returns is
      // what <EmbeddedCheckout> consumes.
      ui_mode: "embedded_page",
      return_url: `${input.baseUrl}/${input.orgSlug}/settings?billing=success`,
    };
  }

  return {
    ...base,
    success_url: `${input.baseUrl}/${input.orgSlug}/settings?billing=success`,
    cancel_url: `${input.baseUrl}/${input.orgSlug}/settings?billing=cancelled`,
  };
}
