import { z } from "zod";
import { verifyTokenSignature } from "./kiosk-token";
import { idSchema } from "./validation";

export const CREW_CHAT_PREFIX = "chat_";
export const PLANNING_CHAT_PREFIX = "planning_chat_";
const common = { orgId: idSchema, orgSlug: z.string().min(1).max(100), exp: z.number().int().nonnegative() };
const crewClaims = z.object({ ...common, scope: z.literal("crew-chat") });
const planningClaims = z.object({ ...common, scope: z.literal("planning-chat"), roomId: z.literal("planning"), targetUserIds: z.array(idSchema).min(1).max(50) });
export type InvalidChatPass = { status: "invalid" | "expired" };
export type CrewChatClaims = Pick<z.infer<typeof crewClaims>, "orgId" | "orgSlug" | "exp">;
export type PlanningChatClaims = CrewChatClaims & Pick<z.infer<typeof planningClaims>, "targetUserIds">;

export async function inspectCrewChatPass(token: string, secret: string): Promise<InvalidChatPass | { status: "valid"; pass: CrewChatClaims }> {
  if (!token.startsWith(CREW_CHAT_PREFIX)) return { status: "invalid" };
  const parsed = crewClaims.safeParse(await verifyTokenSignature(token.slice(CREW_CHAT_PREFIX.length), secret));
  if (!parsed.success) return { status: "invalid" };
  if (parsed.data.exp * 1000 <= Date.now()) return { status: "expired" };
  const { orgId, orgSlug, exp } = parsed.data;
  return { status: "valid", pass: { orgId, orgSlug, exp } };
}
export async function inspectPlanningChatPass(token: string, secret: string): Promise<InvalidChatPass | { status: "valid"; pass: PlanningChatClaims }> {
  if (!token.startsWith(PLANNING_CHAT_PREFIX)) return { status: "invalid" };
  const parsed = planningClaims.safeParse(await verifyTokenSignature(token.slice(PLANNING_CHAT_PREFIX.length), secret));
  if (!parsed.success) return { status: "invalid" };
  if (parsed.data.exp * 1000 <= Date.now()) return { status: "expired" };
  const { orgId, orgSlug, exp, targetUserIds } = parsed.data;
  return { status: "valid", pass: { orgId, orgSlug, exp, targetUserIds } };
}

export type CrewChatJoinState = InvalidChatPass | { status: "unavailable" } | { status: "valid"; pass: CrewChatClaims };
export type PlanningChatJoinState = InvalidChatPass | { status: "unavailable" | "signed-out" | "wrong-account" | "access-removed" }
  | { status: "authorized"; orgSlug: string };
