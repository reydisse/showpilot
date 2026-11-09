import { z } from "zod";
type Identity = { orgId: string; userId: string; roomId: string; messageId: string; requestId: string };
export type ChatNotificationCommand = Identity & (
  | { kind: "message"; text: string; mentionedUserIds: string[] }
  | { kind: "reaction"; targetUserId: string; emoji: string }
);
export const chatNotificationResultSchema = z.object({
  orgId: z.string().min(1), userId: z.string().min(1), roomId: z.string().min(1),
  messageId: z.string().min(1), requestId: z.uuid(), notified: z.number().int().nonnegative(),
});
export type ChatNotificationResult = z.infer<typeof chatNotificationResultSchema>;
