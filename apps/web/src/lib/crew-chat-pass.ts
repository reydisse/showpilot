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
const PLANNING_PASS_PREFIX = "planning_chat_";
const PASS_CREATORS = new Set(["owner", "admin", "td", "pd", "pm", "sm", "tm"]);

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

export async function verifyPlanningChatPass(token: string, secret: string) {
  if (!token.startsWith(PLANNING_PASS_PREFIX)) return null;
  const payload = await verifyToken(token.slice(PLANNING_PASS_PREFIX.length), secret);
  if (
    !payload ||
    payload.scope !== "planning-chat" ||
    payload.roomId !== "planning" ||
    typeof payload.orgId !== "string" ||
    typeof payload.orgSlug !== "string" ||
    !Array.isArray(payload.targetUserIds) ||
    payload.targetUserIds.some((userId) => typeof userId !== "string")
  ) return null;
  return {
    orgId: payload.orgId,
    orgSlug: payload.orgSlug,
    targetUserIds: payload.targetUserIds as string[],
    exp: typeof payload.exp === "number" ? payload.exp : null,
  };
}

export const createPlanningChatPass = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    hours: z.number().int().min(1).max(24),
    targetUserIds: z.array(idSchema).min(1).max(50),
  }), data))
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    if (!session) throw new Error("Unauthorized");
    const prisma = getPrisma();
    const [member, org, targets] = await Promise.all([
      prisma.member.findFirst({ where: { organizationId: data.orgId, userId: session.user.id }, select: { role: true } }),
      prisma.organization.findUnique({ where: { id: data.orgId }, select: { slug: true } }),
      prisma.member.findMany({ where: { organizationId: data.orgId, userId: { in: data.targetUserIds } }, select: { userId: true } }),
    ]);
    const role = normalizeRole(member?.role);
    if (!role || !PASS_CREATORS.has(role)) throw new Error("Only production leaders can share the Planning Room");
    if (!org) throw new Error("Organization not found");
    const targetUserIds = [...new Set(targets.map((target) => target.userId))];
    if (targetUserIds.length !== new Set(data.targetUserIds).size) throw new Error("Every selected person must be an organization member");

    const now = Math.floor(Date.now() / 1000);
    const exp = now + data.hours * 3600;
    const jwt = await signToken({
      scope: "planning-chat",
      roomId: "planning",
      orgId: data.orgId,
      orgSlug: org.slug,
      targetUserIds,
      exp,
      iat: now,
    }, getKioskSecret());
    const token = `${PLANNING_PASS_PREFIX}${jwt}`;
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: session.user.id,
      recipientIds: targetUserIds,
      type: "chat-planning-invite",
      title: `${session.user.name} shared the Planning Room with you`,
      message: "Open the invite to join the targeted Planning Room conversation.",
      actionUrl: "chat?room=planning",
      source: `planning-chat:${crypto.randomUUID()}`,
      pushTag: `planning-chat-invite-${data.orgId}`,
    });
    return { token, orgSlug: org.slug, expiresAt: exp * 1000, targetCount: targetUserIds.length };
  });

export const validatePlanningChatPass = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.string().min(20).max(8192), data))
  .handler(async ({ data }) => {
    const pass = await verifyPlanningChatPass(data, getKioskSecret());
    if (!pass) return null;
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() }).catch(() => null);
    return {
      orgSlug: pass.orgSlug,
      exp: pass.exp,
      signedIn: Boolean(session),
      authorized: Boolean(session && pass.targetUserIds.includes(session.user.id)),
    };
  });
