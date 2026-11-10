import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { getKioskSecret } from "@/lib/kiosk";
import { signToken } from "@/lib/kiosk-token";
import { normalizeRole } from "@/lib/app-permissions";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { z } from "zod";

import { chatTokenIsRevoked, recordChatPassRevocation } from "./chat-pass-revocation.server";
import { refreshRevokedChatGuests } from "./chat-pass-relay.server";
import { getD1 } from "./d1";
import { resolveEffectiveAccess } from "./effective-access";
import { CREW_CHAT_PREFIX as PASS_PREFIX, PLANNING_CHAT_PREFIX as PLANNING_PASS_PREFIX, inspectCrewChatPass, inspectPlanningChatPass, type CrewChatJoinState, type PlanningChatJoinState } from "./chat-pass-token";
const PASS_CREATORS = new Set(["owner", "admin", "td", "pd", "pm", "sm", "tm"]);

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
  .inputValidator((data: unknown) => parseOrThrow(z.string().max(4096), data))
  .handler(async ({ data }): Promise<CrewChatJoinState> => {
    const result = await inspectCrewChatPass(data, getKioskSecret());
    if (result.status !== "valid") return result;
    if (await chatTokenIsRevoked(getD1(), result.pass.orgId, data)) return { status: "revoked" };
    const org = await getPrisma().organization.findUnique({ where: { id: result.pass.orgId }, select: { slug: true } });
    if (!org) return { status: "unavailable" };
    return { status: "valid", pass: { ...result.pass, orgSlug: org.slug } };
  });

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
      category: "chat",
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
  .inputValidator((data: unknown) => parseOrThrow(z.string().max(8192), data))
  .handler(async ({ data }): Promise<PlanningChatJoinState> => {
    const result = await inspectPlanningChatPass(data, getKioskSecret());
    if (result.status !== "valid") return result;
    if (await chatTokenIsRevoked(getD1(), result.pass.orgId, data)) return { status: "revoked" };
    const { pass } = result;
    const org = await getPrisma().organization.findUnique({ where: { id: pass.orgId }, select: { slug: true } });
    if (!org) return { status: "unavailable" };
    const session = await getAuth().api.getSession({ headers: getRequestHeaders(), query: { disableCookieCache: true } });
    if (!session) return { status: "signed-out" };
    if (!pass.targetUserIds.includes(session.user.id)) return { status: "wrong-account" };
    const access = await resolveEffectiveAccess(getD1(), session.user.id, pass.orgId);
    if (!access?.permissions.includes("chat:access")) return { status: "access-removed" };
    return { status: "authorized", orgSlug: org.slug };
  });

export const revokeChatPass = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, token: z.string().min(1).max(8192) }), data))
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({ headers: getRequestHeaders(), query: { disableCookieCache: true } });
    if (!session) throw new Error("Sign in to disable a chat link");
    const access = await resolveEffectiveAccess(getD1(), session.user.id, data.orgId);
    const role = normalizeRole(access?.role);
    if (!role || !PASS_CREATORS.has(role) || !access?.permissions.includes("chat:access")) throw new Error("Only production leaders can disable chat links");
    const scope = data.token.startsWith(PLANNING_PASS_PREFIX) ? "planning-chat" : "crew-chat";
    const inspected = scope === "planning-chat" ? await inspectPlanningChatPass(data.token, getKioskSecret()) : await inspectCrewChatPass(data.token, getKioskSecret());
    if (inspected.status === "invalid") throw new Error("This chat link is invalid. Paste the complete link.");
    if (inspected.status === "expired") return { status: "expired" as const };
    if (inspected.pass.orgId !== data.orgId) throw new Error("This link belongs to a different workspace");
    try {
      await recordChatPassRevocation(getD1(), { orgId: data.orgId, token: data.token, scope, expiresAt: inspected.pass.exp*1000, actorId: session.user.id });
    } catch {
      throw new Error("Could not confirm that the link was disabled. Retry with the same link.");
    }
    const disconnected = scope === "planning-chat" || await refreshRevokedChatGuests(data.orgId);
    return { status: "revoked" as const, disconnected };
  });
