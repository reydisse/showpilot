import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { getKioskSecret } from "@/lib/kiosk";
import { normalizeRole } from "@/lib/app-permissions";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { z } from "zod";

import { issueChatPass, CHAT_PASS_CREATORS, chatPassCreationMessage } from "./chat-pass-issuance.server";
import { crewPassCreationSchema, planningPassCreationSchema } from "./chat-pass-creation";
import { chatTokenIsRevoked, recordChatPassRevocation } from "./chat-pass-revocation.server";
import { refreshRevokedChatGuests } from "./chat-pass-relay.server";
import { getD1 } from "./d1";
import { resolveEffectiveAccess } from "./effective-access";
import { PLANNING_CHAT_PREFIX as PLANNING_PASS_PREFIX, inspectCrewChatPass, inspectPlanningChatPass, type CrewChatJoinState, type PlanningChatJoinState } from "./chat-pass-token";


export const createCrewChatPass = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(crewPassCreationSchema, data))
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({ headers: getRequestHeaders(), query: { disableCookieCache: true } });
    if (!session) throw new Error("Sign in to create a crew pass");
    try { return await issueChatPass(getD1(), getKioskSecret(), { userId: session.user.id, name: session.user.name }, { ...data, scope: "crew-chat" }); }
    catch (error) { throw new Error(chatPassCreationMessage(error)); }
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
  .inputValidator((data: unknown) => parseOrThrow(planningPassCreationSchema, data))
  .handler(async ({ data }) => {
    const session = await getAuth().api.getSession({ headers: getRequestHeaders(), query: { disableCookieCache: true } });
    if (!session) throw new Error("Sign in to share Planning Room");
    try { return await issueChatPass(getD1(), getKioskSecret(), { userId: session.user.id, name: session.user.name }, { ...data, scope: "planning-chat" }); }
    catch (error) { throw new Error(chatPassCreationMessage(error)); }
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
    if (!role || !CHAT_PASS_CREATORS.has(role) || !access?.permissions.includes("chat:access")) throw new Error("Only production leaders can disable chat links");
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
