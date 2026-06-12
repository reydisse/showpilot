import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { getStripe } from "@/lib/billing";
import {
  assertCanDeleteOrg,
  deleteOrganizationCore,
  type PrismaLikeForOrgDeletion,
} from "@/lib/org-deletion-core";

// Workers entry point for organization deletion. All the dangerous logic
// (table derivation, ordering, idempotency) lives in org-deletion-core.ts,
// shared with scripts/delete-org.ts.

async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  const stripe = getStripe();
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    // Re-runs land here: already-cancelled or deleted subscriptions are fine.
    if (
      err instanceof Stripe.errors.StripeError &&
      (err.code === "resource_missing" ||
        /canceled subscription/i.test(err.message))
    ) {
      return;
    }
    throw err;
  }
}

// All org-owned R2 objects live under this prefix. (Today nothing writes to
// it — avatars are user-scoped — but deletion clears it so future org assets
// are covered automatically.)
async function deleteR2Prefix(orgId: string): Promise<number> {
  const bucket = env.STORAGE;
  const prefix = `orgs/${orgId}/`;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, cursor });
    if (listing.objects.length > 0) {
      await bucket.delete(listing.objects.map((o) => o.key));
      deleted += listing.objects.length;
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return deleted;
}

const deleteOrganizationSchema = z.object({
  orgId: idSchema,
  confirmName: z.string().min(1).max(200),
});

export const deleteOrganization = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(deleteOrganizationSchema, data))
  .handler(async ({ data }) => {
    const { getAuth } = await import("@/lib/auth");
    const auth = getAuth();
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });
    if (!session) throw new Error("Unauthorized");

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: data.orgId },
      select: { id: true, name: true },
    });
    if (!org) return { alreadyDeleted: true };

    const member = await prisma.member.findFirst({
      where: { organizationId: data.orgId, userId: session.user.id },
      select: { role: true },
    });
    // Owner-only + fresh-session + name confirmation, all server-side.
    assertCanDeleteOrg({
      role: member?.role ?? null,
      sessionCreatedAt: session.session.createdAt,
      confirmName: data.confirmName,
      orgName: org.name,
    });

    const result = await deleteOrganizationCore({
      prisma: prisma as unknown as PrismaLikeForOrgDeletion,
      orgId: data.orgId,
      cancelStripeSubscription,
      deleteR2Prefix,
    });

    // Revoke the acting session — the org it pointed at no longer exists.
    try {
      await auth.api.signOut({ headers });
    } catch {
      // Session row may already be gone; the client redirects regardless.
    }

    return { alreadyDeleted: result.alreadyDeleted };
  });
