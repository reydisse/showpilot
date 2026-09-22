import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { getEffectivePlan, getPublicLaunchDate, type Plan } from "@/lib/plan-limits";
import {
  buildCheckoutSessionParams,
  checkoutIdempotencyKey,
  isBlockingSubscriptionStatus,
  reusableCheckoutSession,
} from "@/lib/checkout";
import { requireShowPilotBaseUrl } from "@/lib/auth-origins";

export { getPublicLaunchDate };

function getBaseUrl(): string {
  const cfEnv = env as unknown as Record<string, unknown>;
  return requireShowPilotBaseUrl(cfEnv.BETTER_AUTH_URL);
}

// ─── Auth ────────────────────────────────────────────────────

// Checkout/portal are owner+admin only — settings:billing is granted to
// exactly those roles (see ROLE_PERMISSIONS in permissions.ts).
async function assertBillingPermission(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role || !hasPermission(role, "settings:billing")) {
    throw new Error("Forbidden");
  }
  return session.user;
}

// ─── Billing info (settings UI) ──────────────────────────────

export interface OrgBillingInfo {
  plan: string;
  effectivePlan: Plan;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  foundingMember: boolean;
  betaTester: boolean;
  publicLaunchDate: string | null;
  foundingEligible: boolean;
  hasStripeCustomer: boolean;
}

export const getOrgBilling = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<OrgBillingInfo> => {
    await assertBillingPermission(data.orgId);
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: data.orgId },
      select: {
        plan: true,
        trialEndsAt: true,
        betaTester: true,
        foundingMember: true,
        subscriptionStatus: true,
        stripeCustomerId: true,
        createdAt: true,
      },
    });
    if (!org) throw new Error("Organization not found");

    const publicLaunchDate = await getPublicLaunchDate();
    return {
      plan: org.plan,
      effectivePlan: getEffectivePlan(org, publicLaunchDate),
      subscriptionStatus: org.subscriptionStatus,
      trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
      foundingMember: org.foundingMember,
      betaTester: org.betaTester,
      publicLaunchDate: publicLaunchDate?.toISOString() ?? null,
      // Founding rate is reserved for orgs created before public launch.
      foundingEligible: !publicLaunchDate || org.createdAt < publicLaunchDate,
      hasStripeCustomer: Boolean(org.stripeCustomerId),
    };
  });

// ─── Checkout ────────────────────────────────────────────────

const checkoutSchema = z.object({
  orgId: idSchema,
  plan: z.enum(["starter", "pro", "founding"]),
  // Default "hosted" keeps the original flow when the client doesn't (or
  // can't) request embedded — e.g. VITE_STRIPE_PUBLISHABLE_KEY is unset.
  uiMode: z.enum(["embedded", "hosted"]).default("hosted"),
});

export type CheckoutSessionResult =
  | { mode: "embedded"; clientSecret: string }
  | { mode: "hosted"; url: string };

function checkoutResult(
  uiMode: "embedded" | "hosted",
  session: { client_secret: string | null; url: string | null },
): CheckoutSessionResult {
  if (uiMode === "embedded") {
    if (!session.client_secret) throw new Error("Stripe did not return a client secret");
    return { mode: "embedded", clientSecret: session.client_secret };
  }
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { mode: "hosted", url: session.url };
}

export const createCheckoutSession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(checkoutSchema, data))
  .handler(async ({ data }): Promise<CheckoutSessionResult> => {
    const user = await assertBillingPermission(data.orgId);
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: data.orgId },
      select: { id: true, name: true, slug: true, stripeCustomerId: true, createdAt: true },
    });
    if (!org) throw new Error("Organization not found");

    if (data.plan === "founding") {
      const publicLaunchDate = await getPublicLaunchDate();
      if (publicLaunchDate && org.createdAt >= publicLaunchDate) {
        throw new Error("The founding rate is only available to organizations created before public launch");
      }
    }

    const { getStripe, getStripePriceIds } = await import("@/lib/stripe.server");
    const stripe = getStripe();

    let customerId = org.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          name: org.name,
          email: user.email,
          metadata: { orgId: org.id },
        },
        { idempotencyKey: `showpilot-customer:${org.id}` },
      );
      customerId = customer.id;
      await prisma.organization.update({
        where: { id: org.id },
        data: { stripeCustomerId: customerId },
      });
    }

    // Stripe is canonical here. This catches a delayed local webhook and
    // prevents a second billable subscription from another tab or retry.
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    if (subscriptions.data.some((subscription) => isBlockingSubscriptionStatus(subscription.status))) {
      throw new Error("This organization already has a subscription. Manage it in the billing portal.");
    }

    const openSessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: "open",
      limit: 100,
    });
    const reusable = reusableCheckoutSession(openSessions.data, {
      orgId: org.id,
      plan: data.plan,
      uiMode: data.uiMode,
    });
    if (reusable) return checkoutResult(data.uiMode, reusable);

    const prices = getStripePriceIds();
    const session = await stripe.checkout.sessions.create(
      buildCheckoutSessionParams({
        uiMode: data.uiMode,
        customerId,
        orgId: org.id,
        orgSlug: org.slug,
        plan: data.plan,
        priceId: prices[data.plan],
        baseUrl: getBaseUrl(),
      }),
      {
        idempotencyKey: checkoutIdempotencyKey(org.id, data.plan, data.uiMode),
      },
    );
    return checkoutResult(data.uiMode, session);
  });

// ─── Billing portal ──────────────────────────────────────────

export const createPortalSession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertBillingPermission(data.orgId);
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: data.orgId },
      select: { slug: true, stripeCustomerId: true },
    });
    if (!org) throw new Error("Organization not found");
    if (!org.stripeCustomerId) throw new Error("No billing account yet — subscribe to a plan first");

    const { getStripe } = await import("@/lib/stripe.server");
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${getBaseUrl()}/${org.slug}/settings`,
    });
    return { url: session.url };
  });
