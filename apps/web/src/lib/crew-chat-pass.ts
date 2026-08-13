import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { getKioskSecret } from "@/lib/kiosk";
import { signToken, verifyToken } from "@/lib/kiosk-token";
import { normalizeRole } from "@/lib/app-permissions";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { z } from "zod";

const PASS_PREFIX = "chat_";
const PASS_CREATORS = new Set(["owner", "admin", "td", "pd", "pm", "tm"]);

export async function verifyCrewChatPass(token: string, secret: string) {
  if (!token.startsWith(PASS_PREFIX)) return null;
  const payload = await verifyToken(token.slice(PASS_PREFIX.length), secret);
  if (!payload || payload.scope !== "crew-chat" || typeof payload.orgId !== "string" || typeof payload.orgSlug !== "string") return null;
  return { orgId: payload.orgId, orgSlug: payload.orgSlug, exp: typeof payload.exp === "number" ? payload.exp : null };
}

export const createCrewChatPass = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, hours: z.number().int().min(1).max(24) }), data))
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    if (!session) throw new Error("Unauthorized");
    const prisma = getPrisma();
    const [member, org] = await Promise.all([
      prisma.member.findFirst({ where: { organizationId: data.orgId, userId: session.user.id }, select: { role: true } }),
      prisma.organization.findUnique({ where: { id: data.orgId }, select: { slug: true } }),
    ]);
    const role = normalizeRole(member?.role);
    if (!role || !PASS_CREATORS.has(role)) throw new Error("Only production leaders can invite guest crew");
    if (!org) throw new Error("Organization not found");
    const exp = Math.floor(Date.now() / 1000) + data.hours * 3600;
    const jwt = await signToken({ scope: "crew-chat", orgId: data.orgId, orgSlug: org.slug, exp, iat: Math.floor(Date.now() / 1000) }, getKioskSecret());
    return { token: `${PASS_PREFIX}${jwt}`, orgSlug: org.slug, expiresAt: exp * 1000 };
  });

export const validateCrewChatPass = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.string().min(20).max(4096), data))
  .handler(async ({ data }) => verifyCrewChatPass(data, getKioskSecret()));
