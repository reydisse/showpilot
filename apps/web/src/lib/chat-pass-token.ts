import { z } from "zod";
import { verifyTokenSignature } from "./kiosk-token";
import { idSchema } from "./validation";

export const CREW_CHAT_PREFIX = "chat_";
export const PLANNING_CHAT_PREFIX = "planning_chat_";
const common = { orgId: idSchema, orgSlug: z.string().min(1).max(100), exp: z.number().int().nonnegative() };
export const crewChatClaimsSchema = z.object({ ...common, scope: z.literal("crew-chat") });
export const planningChatClaimsSchema = z.object({ ...common, scope: z.literal("planning-chat"), roomId: z.literal("planning"), targetUserIds: z.array(idSchema).min(1).max(50) });
export type InvalidChatPass = { status: "invalid" } | { status: "expired" };
export type CrewChatClaims = Pick<z.infer<typeof crewChatClaimsSchema>, "orgId" | "orgSlug" | "exp">;
export type PlanningChatClaims = CrewChatClaims & Pick<z.infer<typeof planningChatClaimsSchema>, "targetUserIds">;

export async function inspectCrewChatPass(token: string, secret: string): Promise<InvalidChatPass | { status: "valid"; pass: CrewChatClaims }> {
  if (!/^chat_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return { status: "invalid" };
  const parsed = crewChatClaimsSchema.safeParse(await verifyTokenSignature(token.slice(CREW_CHAT_PREFIX.length), secret));
  if (!parsed.success) return { status: "invalid" };
  if (parsed.data.exp * 1000 <= Date.now()) return { status: "expired" };
  const { orgId, orgSlug, exp } = parsed.data;
  return { status: "valid", pass: { orgId, orgSlug, exp } };
}
export async function inspectPlanningChatPass(token: string, secret: string): Promise<InvalidChatPass | { status: "valid"; pass: PlanningChatClaims }> {
  if (!/^planning_chat_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return { status: "invalid" };
  const parsed = planningChatClaimsSchema.safeParse(await verifyTokenSignature(token.slice(PLANNING_CHAT_PREFIX.length), secret));
  if (!parsed.success) return { status: "invalid" };
  if (parsed.data.exp * 1000 <= Date.now()) return { status: "expired" };
  const { orgId, orgSlug, exp, targetUserIds } = parsed.data;
  return { status: "valid", pass: { orgId, orgSlug, exp, targetUserIds } };
}

export type CrewChatJoinState = InvalidChatPass | { status: "revoked" } | { status: "unavailable" } | { status: "valid"; pass: CrewChatClaims };
export type PlanningChatJoinState = InvalidChatPass | { status: "revoked" } | { status: "unavailable" | "signed-out" | "wrong-account" | "access-removed" }
  | { status: "authorized"; orgSlug: string };
