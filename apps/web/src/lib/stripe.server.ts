import { env } from "cloudflare:workers";
import Stripe from "stripe";

function requireEnv(name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is not configured`);
  }
  return value;
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
} {
  return {
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
