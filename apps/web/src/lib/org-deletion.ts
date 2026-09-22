import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { idSchema, parseOrThrow } from "@/lib/validation";
import {
  assertCanDeleteOrg,
  deleteOrganizationCore,
  type PrismaLikeForOrgDeletion,
} from "@/lib/org-deletion-core";
import { chatRelayKey } from "@/lib/chat-relay-key";
import { rundownRelayKey } from "@/lib/rundown-relay-key";

// Workers entry point for organization deletion. All the dangerous logic
// (table derivation, ordering, idempotency) lives in org-deletion-core.ts,
// shared with scripts/delete-org.ts.

async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  const { getStripe, isMissingStripeResource } = await import("@/lib/stripe.server");
  const stripe = getStripe();
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (err) {
    // Re-runs land here: already-cancelled or deleted subscriptions are fine.
    if (isMissingStripeResource(err)) {
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

interface OrgDeletionRelayEnv {
  BETTER_AUTH_SECRET?: string;
  CHAT_RELAY: DurableObjectNamespace;
  TIMECODE_RELAY: DurableObjectNamespace;
  BRIDGE_RELAY: DurableObjectNamespace;
  RUNDOWN_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
  CUE_SHEET_RELAY: DurableObjectNamespace;
  DB: D1Database;
}

async function purgeRelay(
  namespace: DurableObjectNamespace,
  key: string,
  secret: string,
): Promise<void> {
  const stub = namespace.get(namespace.idFromName(key));
  const response = await stub.fetch(new Request("https://showpilot.internal/internal/purge-org", {
    method: "POST",
    headers: { "x-showpilot-internal-secret": secret },
  }));
  if (!response.ok) throw new Error(`Relay cleanup failed with status ${response.status}`);
}

async function markOrganizationDeleting(orgId: string): Promise<void> {
  await getPrisma().appSetting.upsert({
    where: { orgId_key: { orgId, key: "organization-deleting" } },
    update: { value: new Date().toISOString() },
    create: { orgId, key: "organization-deleting", value: new Date().toISOString() },
  });
}

async function purgeOrganizationExternalState(orgId: string): Promise<void> {
  const bindings = env as unknown as OrgDeletionRelayEnv;
  const secret = bindings.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured");

  const [indexedRooms, shows] = await Promise.all([
    bindings.DB.prepare("SELECT DISTINCT roomId FROM chat_user_room WHERE orgId = ?")
      .bind(orgId).all<{ roomId: string }>(),
    getPrisma().rundown.findMany({
      where: { orgId },
      select: { id: true, serviceDate: true },
    }),
  ]);
  const chatKeys = new Set([
    chatRelayKey(orgId, "production"),
    chatRelayKey(orgId, "planning"),
    ...(indexedRooms.results ?? []).map((row) => chatRelayKey(orgId, row.roomId)),
  ]);
  const rundownKeys = new Set([
    orgId,
    ...shows.flatMap((show) => [
      rundownRelayKey(orgId, show.serviceDate, "", show.id),
      rundownRelayKey(orgId, show.serviceDate, ""),
    ]),
  ]);

  await Promise.all([
    ...[...chatKeys].map((key) => purgeRelay(bindings.CHAT_RELAY, key, secret)),
    ...[...rundownKeys].map((key) => purgeRelay(bindings.RUNDOWN_RELAY, key, secret)),
    purgeRelay(bindings.TIMECODE_RELAY, orgId, secret),
    purgeRelay(bindings.BRIDGE_RELAY, orgId, secret),
    purgeRelay(bindings.LOWER_THIRDS_RELAY, orgId, secret),
    purgeRelay(bindings.CUE_SHEET_RELAY, orgId, secret),
  ]);

  await bindings.DB.prepare("DELETE FROM chat_user_room WHERE orgId = ?").bind(orgId).run();
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
      markDeleting: markOrganizationDeleting,
      purgeExternalState: purgeOrganizationExternalState,
    });

    // Revoke the acting session — the org it pointed at no longer exists.
    try {
      await auth.api.signOut({ headers });
    } catch {
      // Session row may already be gone; the client redirects regardless.
    }

    return { alreadyDeleted: result.alreadyDeleted };
  });
