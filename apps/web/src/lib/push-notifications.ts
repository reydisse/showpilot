import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { idSchema, parseOrThrow } from "@/lib/validation";

async function assertMember(orgId: string) {
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { id: true },
  });
  if (!member) throw new Error("Forbidden");
  return session.user.id;
}

export const getPushConfiguration = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertMember(data.orgId);
    const publicKey = String(env.VAPID_PUBLIC_KEY ?? "");
    return { supported: Boolean(publicKey), publicKey };
  });

export const savePushSubscription = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    endpoint: z.string().url().max(2000),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  }), data))
  .handler(async ({ data }) => {
    const userId = await assertMember(data.orgId);
    await getD1().prepare(
      `INSERT INTO push_subscription (id, orgId, userId, endpoint, p256dh, auth, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(endpoint) DO UPDATE SET orgId = excluded.orgId, userId = excluded.userId,
         p256dh = excluded.p256dh, auth = excluded.auth, updatedAt = CURRENT_TIMESTAMP`,
    ).bind(crypto.randomUUID(), data.orgId, userId, data.endpoint, data.keys.p256dh, data.keys.auth).run();
    return { ok: true as const };
  });
