import { env } from "cloudflare:workers";
import Stripe from "stripe";

function requireEnv(name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Build the Stripe client only inside a server handler. */
export function getStripe(): Stripe {
  return new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getStripePriceIds(): {
  starter: string;
  pro: string;
  founding: string;
  starterAnnual?: string;
  proAnnual?: string;
  foundingAnnual?: string;
} {
  return {
    starterAnnual: optionalEnv("STRIPE_PRICE_STARTER_ANNUAL"),
    proAnnual: optionalEnv("STRIPE_PRICE_PRO_ANNUAL"),
    foundingAnnual: optionalEnv("STRIPE_PRICE_FOUNDING_ANNUAL"),
    starter: requireEnv("STRIPE_PRICE_STARTER"),
    pro: requireEnv("STRIPE_PRICE_PRO"),
    founding: requireEnv("STRIPE_PRICE_FOUNDING"),
  };
}

export function isMissingStripeResource(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeError &&
    (error.code === "resource_missing" ||
      /canceled subscription/i.test(error.message))
  );
}

export function createStripeCryptoProvider() {
  return Stripe.createSubtleCryptoProvider();
}

/** Resolve checkout prices from the same map used by webhook plan resolution. */
export function getStripePriceId(plan: "starter" | "pro" | "founding", interval: "monthly" | "annual"): string {
  const prices = getStripePriceIds();
  const priceId = interval === "annual" ? prices[`${plan}Annual`] : prices[plan];
  if (!priceId) throw new Error("Annual billing is not configured for this plan yet");
  return priceId;
}
