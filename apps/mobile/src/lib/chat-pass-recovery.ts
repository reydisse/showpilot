import { z } from "zod";
const identity = { orgId: z.string().min(1), userId: z.string().min(1), requestId: z.uuid() };
const fields = { ...identity, hours: z.number().int().min(1).max(24) };
export const chatInviteCommandSchema = z.discriminatedUnion("scope", [
  z.object({ ...fields, scope: z.literal("crew-chat") }),
  z.object({ ...fields, scope: z.literal("planning-chat"), targetUserIds: z.array(z.string().min(1)).min(1).max(50) }),
]);
export type ChatInviteCommand = z.infer<typeof chatInviteCommandSchema>;
export const chatInviteReplySchema = z.object({
  ...identity, scope: z.enum(["crew-chat", "planning-chat"]),
  token: z.string().min(1), expiresAt: z.number().int().positive(), joinUrl: z.url(), targetCount: z.number().int().nonnegative().optional(),
  notifications: z.discriminatedUnion("status", [
    z.object({ status: z.literal("not-needed") }),
    z.object({ status: z.literal("saved"), recipients: z.number().int().nonnegative() }),
    z.object({ status: z.literal("pending"), missing: z.number().int().positive() }),
  ]),
});
export type ChatInviteReply = z.infer<typeof chatInviteReplySchema>;
export type ChatInviteDraft = { scope: ChatInviteCommand["scope"]; hours: number; targetUserIds: string[]; error?: string };
