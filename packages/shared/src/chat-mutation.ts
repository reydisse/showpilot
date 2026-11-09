import { z } from "zod";
import { isEmojiReaction } from "./emoji";

const id = z.string().min(1).max(220);
const editTime = z.number().int().nonnegative();
export const chatMutationOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), text: z.string().trim().min(1).max(4000), expectedEditTime: editTime }).strict(),
  z.object({ kind: z.literal("delete"), expectedEditTime: editTime }).strict(),
  z.object({ kind: z.literal("reaction"), emoji: z.string().refine(isEmojiReaction), active: z.boolean() }).strict(),
  z.object({ kind: z.literal("vote"), optionId: id, expectedOptionId: id.nullable() }).strict(),
]);
export const chatMutationCommandSchema = z.object({
  orgId: id, userId: id, roomId: id, messageId: id, requestId: z.uuid(),
  expiresAt: z.number().int().positive(), operation: chatMutationOperationSchema,
}).strict();
export type ChatMutationCommand = z.infer<typeof chatMutationCommandSchema>;
export type ChatMutationOperation = ChatMutationCommand["operation"];
export const chatMutationResultSchema = z.object({
  command: chatMutationCommandSchema,
  outcome: z.enum(["applied", "superseded", "conflict", "expired", "not-found", "not-owner", "invalid-option"]),
  at: z.number().int().nonnegative(),
  cleanup: z.enum(["complete", "pending", "failed"]),
}).strict();
export type ChatMutationResult = z.infer<typeof chatMutationResultSchema>;

export function chatEditTime(message: { timestamp: number; editedAt?: number }) {
  return message.editedAt ?? message.timestamp;
}
export function chatMutationSummary(operation: ChatMutationOperation): string {
  switch (operation.kind) {
    case "edit": return `Edit: ${operation.text}`;
    case "delete": return "Delete message";
    case "reaction": return `${operation.active ? "Add" : "Remove"} reaction ${operation.emoji}`;
    case "vote": return "Change poll vote";
  }
}
export function chatMutationOutcomeMessage(result: ChatMutationResult): string {
  if (result.outcome === "applied" && result.cleanup !== "complete") return "Message deleted. Attachment cleanup was not confirmed; retry cleanup without deleting again.";
  switch (result.outcome) {
    case "applied": return "Your change was saved.";
    case "superseded": return "Your earlier change was saved. The message has since changed; its current state was preserved.";
    case "conflict": return "The message changed before your request arrived. Review the current message before making another change.";
    case "expired": return "This change arrived too late and was not applied. Review the current message and try again.";
    case "not-found": return "The message is no longer available. This change was not applied.";
    case "not-owner": return "You can only edit or delete your own messages.";
    case "invalid-option": return "That poll option is no longer available. Review the poll before voting again.";
  }
}
