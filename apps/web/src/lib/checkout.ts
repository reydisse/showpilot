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
  plan: "starter" | "pro" | "founding";
  priceId: string;
  baseUrl: string;
}

const TERMINAL_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

/** Any non-terminal Stripe subscription must be managed instead of duplicated. */
export function isBlockingSubscriptionStatus(status: string): boolean {
  return !TERMINAL_SUBSCRIPTION_STATUSES.has(status);
}

export function checkoutIdempotencyKey(
  orgId: string,
  plan: CheckoutSessionParamsInput["plan"],
  uiMode: CheckoutUiMode,
  now: Date = new Date(),
): string {
  // Checkout Sessions expire after 24 hours. A UTC-day operation key converges
  // simultaneous tabs/retries without pinning a future attempt to an expired session.
  return `showpilot-checkout:${orgId}:${plan}:${uiMode}:${now.toISOString().slice(0, 10)}`;
}

export function reusableCheckoutSession(
  sessions: Stripe.Checkout.Session[],
  input: Pick<CheckoutSessionParamsInput, "orgId" | "plan" | "uiMode">,
): Stripe.Checkout.Session | undefined {
  return sessions.find((session) =>
    session.status === "open"
    && session.mode === "subscription"
    && session.metadata?.orgId === input.orgId
    && session.metadata?.plan === input.plan
    && session.metadata?.uiMode === input.uiMode
  );
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
    metadata: {
      orgId: input.orgId,
      plan: input.plan,
      uiMode: input.uiMode,
    },
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
