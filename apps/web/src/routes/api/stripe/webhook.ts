import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import { getPrisma } from "@/lib/db";
import { getStripe, getStripePriceIds } from "@/lib/billing";
import { planFromPriceId } from "@/lib/plan-limits";

// Stripe → ShowPilot billing sync. Signature-verified; no auth session.
// Keep handlers fast — Stripe retries on non-2xx.

const cryptoProvider = Stripe.createSubtleCryptoProvider();

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Resolve the org a Stripe object belongs to: client_reference_id first, then customer. */
async function findOrgId(
  clientReferenceId: string | null,
  customerId: string | null,
): Promise<string | null> {
  const prisma = getPrisma();
  if (clientReferenceId) {
    const org = await prisma.organization.findUnique({
      where: { id: clientReferenceId },
      select: { id: true },
    });
    if (org) return org.id;
  }
  if (customerId) {
    const org = await prisma.organization.findUnique({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });
    if (org) return org.id;
  }
  return null;
}

function subscriptionPlan(subscription: Stripe.Subscription) {
  const priceId = subscription.items.data[0]?.price?.id;
  return priceId ? planFromPriceId(priceId, getStripePriceIds()) : null;
}

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const orgId = await findOrgId(session.client_reference_id, customerId);
  if (!orgId) {
    console.error("[stripe] checkout.session.completed: no org found", session.id);
    return;
  }

  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!subscriptionId) {
    console.error("[stripe] checkout.session.completed: no subscription on session", session.id);
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const mapped = subscriptionPlan(subscription);
  if (!mapped) {
    console.error("[stripe] checkout.session.completed: unknown price", subscription.id);
    return;
  }

  const prisma = getPrisma();
  await prisma.organization.update({
    where: { id: orgId },
    data: {
      plan: mapped.plan,
      ...(mapped.foundingMember ? { foundingMember: true } : {}),
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
    },
  });
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const prisma = getPrisma();
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id ?? null;

  let org = await prisma.organization.findFirst({
    where: { stripeSubscriptionId: subscription.id },
    select: { id: true },
  });
  if (!org && customerId) {
    org = await prisma.organization.findUnique({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });
  }
  if (!org) {
    console.error("[stripe] subscription.updated: no org found", subscription.id);
    return;
  }

  const mapped = subscriptionPlan(subscription);
  await prisma.organization.update({
    where: { id: org.id },
    data: {
      subscriptionStatus: subscription.status,
      stripeSubscriptionId: subscription.id,
      ...(mapped ? { plan: mapped.plan, ...(mapped.foundingMember ? { foundingMember: true } : {}) } : {}),
    },
  });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const prisma = getPrisma();
  const result = await prisma.organization.updateMany({
    where: { stripeSubscriptionId: subscription.id },
    data: {
      plan: "free",
      stripeSubscriptionId: null,
      subscriptionStatus: "canceled",
    },
  });
  if (result.count === 0) {
    console.error("[stripe] subscription.deleted: no org found", subscription.id);
  }
}

export const Route = createFileRoute("/api/stripe/webhook")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const webhookSecret = (env as unknown as Record<string, unknown>)
          .STRIPE_WEBHOOK_SECRET as string | undefined;
        if (!webhookSecret) {
          console.error("[stripe] STRIPE_WEBHOOK_SECRET is not configured");
          return json(500, { error: "Webhook not configured" });
        }

        const signature = request.headers.get("stripe-signature");
        if (!signature) return json(400, { error: "Missing stripe-signature header" });

        const stripe = getStripe();
        let event: Stripe.Event;
        try {
          // Async variant — required on Workers (SubtleCrypto).
          event = await stripe.webhooks.constructEventAsync(
            await request.text(),
            signature,
            webhookSecret,
            undefined,
            cryptoProvider,
          );
        } catch (err) {
          console.error("[stripe] webhook signature verification failed:", err);
          return json(400, { error: "Invalid signature" });
        }

        try {
          switch (event.type) {
            case "checkout.session.completed":
              await handleCheckoutCompleted(stripe, event.data.object);
              break;
            case "customer.subscription.updated":
              await handleSubscriptionUpdated(event.data.object);
              break;
            case "customer.subscription.deleted":
              await handleSubscriptionDeleted(event.data.object);
              break;
            default:
              console.log("[stripe] unhandled event type:", event.type);
          }
        } catch (err) {
          // Surface a 500 so Stripe retries — these handlers are idempotent.
          console.error(`[stripe] failed to process ${event.type}:`, err);
          return json(500, { error: "Processing failed" });
        }

        return json(200, { received: true });
      },
    },
  },
});
