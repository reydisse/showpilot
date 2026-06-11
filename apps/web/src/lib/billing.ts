import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { getEffectivePlan, getPublicLaunchDate, type Plan } from "@/lib/plan-limits";

export { getPublicLaunchDate };

// ─── Env / Stripe client ─────────────────────────────────────

// Fail closed: billing cannot run without its secrets. Set via
// `wrangler secret put <NAME>` (and .dev.vars locally).
function requireEnv(name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name] as string | undefined;
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

// Workers has no Node http — Stripe must use the fetch client.
export function getStripe(): Stripe {
  return new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getStripePriceIds(): { starter: string; pro: string; founding: string } {
  return {
    starter: requireEnv("STRIPE_PRICE_STARTER"),
    pro: requireEnv("STRIPE_PRICE_PRO"),
    founding: requireEnv("STRIPE_PRICE_FOUNDING"),
  };
}

function getBaseUrl(): string {
  const cfEnv = env as unknown as Record<string, unknown>;
  return (cfEnv.BETTER_AUTH_URL as string) || "https://showpilot.tech";
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
});

export const createCheckoutSession = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(checkoutSchema, data))
  .handler(async ({ data }) => {
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

    const stripe = getStripe();

    let customerId = org.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: org.name,
        email: user.email,
        metadata: { orgId: org.id },
      });
      customerId = customer.id;
      await prisma.organization.update({
        where: { id: org.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const prices = getStripePriceIds();
    const baseUrl = getBaseUrl();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: org.id,
      line_items: [{ price: prices[data.plan], quantity: 1 }],
      subscription_data: { metadata: { orgId: org.id } },
      success_url: `${baseUrl}/${org.slug}/settings?billing=success`,
      cancel_url: `${baseUrl}/${org.slug}/settings?billing=cancelled`,
    });

    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { url: session.url };
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

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: org.stripeCustomerId,
      return_url: `${getBaseUrl()}/${org.slug}/settings`,
    });
    return { url: session.url };
  });
