import { z } from "zod";
import { idSchema } from "./validation";

export const chatPassCreationFields = {
  orgId: idSchema,
  hours: z.number().int().min(1).max(24),
  requestId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
};
export const crewPassCreationSchema = z.object(chatPassCreationFields);
export const planningPassCreationSchema = z.object({ ...chatPassCreationFields, targetUserIds: z.array(idSchema).min(1).max(50) });
export const chatPassCommandSchema = z.discriminatedUnion("scope", [
  crewPassCreationSchema.extend({ scope: z.literal("crew-chat") }),
  planningPassCreationSchema.extend({ scope: z.literal("planning-chat") }),
]);
export type ChatPassCommand = z.infer<typeof chatPassCommandSchema>;
export type ChatPassNotification = { status: "not-needed" } | { status: "saved"; recipients: number } | { status: "pending"; missing: number };
export type CreatedChatPass = { token: string; orgSlug: string; expiresAt: number; targetCount: number; notifications: ChatPassNotification };
