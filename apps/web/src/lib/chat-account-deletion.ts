export interface DeletableChatMessage {
  id: string;
  orgId: string;
  senderId?: string;
  replyTo?: { messageId: string; senderName: string; text: string };
  attachments?: Array<{ url: string }>;
  reactions?: Array<{ emoji: string; userIds: string[] }>;
  poll?: { question: string; options: Array<{ id: string; text: string; voterIds: string[] }> };
}
export function scrubDeletedUserFromChat<T extends DeletableChatMessage>(
  messages: T[],
  userId: string,
): { messages: T[]; deleted: T[] } {
  const deleted = messages.filter((message) => message.senderId === userId);
  const deletedIds = new Set(deleted.map((message) => message.id));
  const remaining = messages
    .filter((message) => !deletedIds.has(message.id))
    .map((message) => {
      const replyTo = message.replyTo && deletedIds.has(message.replyTo.messageId)
        ? { messageId: message.replyTo.messageId, senderName: "Deleted user", text: "Message deleted" }
        : message.replyTo;
      const reactions = message.reactions
        ?.map((reaction) => ({ ...reaction, userIds: reaction.userIds.filter((id) => id !== userId) }))
        .filter((reaction) => reaction.userIds.length > 0);
      const poll = message.poll
        ? {
            ...message.poll,
            options: message.poll.options.map((option) => ({
              ...option,
              voterIds: option.voterIds.filter((id) => id !== userId),
            })),
          }
        : undefined;
      return { ...message, replyTo, reactions, poll } as T;
    });
  return { messages: remaining, deleted };
}
