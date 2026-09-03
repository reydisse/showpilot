export interface MobileChatMessage {
  id: string;
  senderId?: string;
  senderName: string;
  senderRole?: string;
  text: string;
  type: "text" | "alert" | "cue" | "system";
  timestamp: number;
  threadRootId?: string;
  replyTo?: { messageId: string; senderName: string; text: string };
  attachments?: { id: string; name: string; url: string; mimeType: string; size: number }[];
  poll?: { question: string; options: { id: string; text: string; voterIds: string[] }[] };
  reactions?: { emoji: MobileChatReactionEmoji; userIds: string[] }[];
  editedAt?: number;
  deletedAt?: number;
  external?: { platform: "mattermost" | "slack" | "discord" | "teams"; id: string };
  externalDelivery?: {
    platform: "mattermost" | "slack" | "discord" | "teams";
    status: "pending" | "sent" | "failed";
    error?: string;
  };
}

export const mobileChatReactionEmojis = [
  "👍", "👎", "❤️", "🔥", "🎉", "😂", "😮", "😢", "🙏", "👏",
  "🙌", "💯", "✅", "❌", "⚠️", "👀", "🤔", "💡", "🚀", "🎬",
  "🎥", "🎤", "🎧", "🔊", "🔇", "⏱️", "📌", "🛠️", "🫡", "🤝",
] as const;
export type MobileChatReactionEmoji = (typeof mobileChatReactionEmojis)[number];

function isMobileChatReactionEmoji(value: unknown): value is MobileChatReactionEmoji {
  return mobileChatReactionEmojis.some((emoji) => emoji === value);
}

export interface ChatHistoryCursor {
  timestamp: number;
  id: string;
}

export interface ChatHistoryPage {
  messages: MobileChatMessage[];
  nextCursor: ChatHistoryCursor | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReply(value: unknown): MobileChatMessage["replyTo"] {
  if (!isRecord(value)
    || typeof value.messageId !== "string"
    || typeof value.senderName !== "string"
    || typeof value.text !== "string") return undefined;
  return { messageId: value.messageId, senderName: value.senderName, text: value.text };
}

function parseAttachments(value: unknown): MobileChatMessage["attachments"] {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.slice(0, 6).flatMap((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.id !== "string"
      || typeof candidate.name !== "string"
      || typeof candidate.url !== "string"
      || typeof candidate.mimeType !== "string"
      || typeof candidate.size !== "number"
      || !Number.isFinite(candidate.size)) return [];
    return [{ id: candidate.id, name: candidate.name, url: candidate.url, mimeType: candidate.mimeType, size: candidate.size }];
  });
  return attachments.length ? attachments : undefined;
}

function parsePoll(value: unknown): MobileChatMessage["poll"] {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.options)) return undefined;
  const options = value.options.slice(0, 6).flatMap((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.id !== "string"
      || typeof candidate.text !== "string"
      || !Array.isArray(candidate.voterIds)) return [];
    const voterIds = candidate.voterIds.filter((userId): userId is string => typeof userId === "string");
    return [{ id: candidate.id, text: candidate.text, voterIds }];
  });
  return options.length >= 2 ? { question: value.question, options } : undefined;
}

function parseReactions(value: unknown): MobileChatMessage["reactions"] {
  if (!Array.isArray(value)) return undefined;
  const reactions = value.flatMap((candidate) => {
    if (!isRecord(candidate)
      || !isMobileChatReactionEmoji(candidate.emoji)
      || !Array.isArray(candidate.userIds)) return [];
    return [{
      emoji: candidate.emoji,
      userIds: candidate.userIds.filter((userId): userId is string => typeof userId === "string"),
    }];
  });
  return reactions.length ? reactions : undefined;
}

function parseExternalPlatform(value: unknown): "mattermost" | "slack" | "discord" | "teams" | null {
  return value === "mattermost" || value === "slack" || value === "discord" || value === "teams" ? value : null;
}

export function parseChatMessage(value: unknown): MobileChatMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string"
    || typeof value.senderName !== "string"
    || typeof value.text !== "string"
    || typeof value.timestamp !== "number"
    || !Number.isFinite(value.timestamp)
    || (value.type !== "text" && value.type !== "alert" && value.type !== "cue" && value.type !== "system")) {
    return null;
  }
  const replyTo = parseReply(value.replyTo);
  const attachments = parseAttachments(value.attachments);
  const poll = parsePoll(value.poll);
  const reactions = parseReactions(value.reactions);
  const externalPlatform = isRecord(value.external) ? parseExternalPlatform(value.external.platform) : null;
  const deliveryPlatform = isRecord(value.externalDelivery) ? parseExternalPlatform(value.externalDelivery.platform) : null;
  const deliveryStatus = isRecord(value.externalDelivery)
    && (value.externalDelivery.status === "pending" || value.externalDelivery.status === "sent" || value.externalDelivery.status === "failed")
    ? value.externalDelivery.status
    : null;
  return {
    id: value.id,
    senderName: value.senderName,
    text: value.text,
    type: value.type,
    timestamp: value.timestamp,
    ...(typeof value.threadRootId === "string" ? { threadRootId: value.threadRootId } : {}),
    ...(typeof value.senderId === "string" ? { senderId: value.senderId } : {}),
    ...(typeof value.senderRole === "string" ? { senderRole: value.senderRole } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(attachments ? { attachments } : {}),
    ...(poll ? { poll } : {}),
    ...(reactions ? { reactions } : {}),
    ...(typeof value.editedAt === "number" && Number.isFinite(value.editedAt) ? { editedAt: value.editedAt } : {}),
    ...(typeof value.deletedAt === "number" && Number.isFinite(value.deletedAt) ? { deletedAt: value.deletedAt } : {}),
    ...(externalPlatform && isRecord(value.external) && typeof value.external.id === "string"
      ? { external: { platform: externalPlatform, id: value.external.id } }
      : {}),
    ...(deliveryPlatform && deliveryStatus && isRecord(value.externalDelivery)
      ? {
          externalDelivery: {
            platform: deliveryPlatform,
            status: deliveryStatus,
            ...(typeof value.externalDelivery.error === "string" ? { error: value.externalDelivery.error } : {}),
          },
        }
      : {}),
  };
}

export function compareChatMessages(left: MobileChatMessage, right: MobileChatMessage): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

export function mergeChatMessage(
  messages: MobileChatMessage[],
  message: MobileChatMessage,
): MobileChatMessage[] {
  const existing = messages.findIndex((candidate) => candidate.id === message.id);
  if (existing < 0) return [...messages, message].sort(compareChatMessages);
  const next = [...messages];
  next[existing] = message;
  return next;
}

export function parseChatHistoryPage(value: unknown): ChatHistoryPage | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const messages = value.messages.flatMap((candidate) => {
    const message = parseChatMessage(candidate);
    return message ? [message] : [];
  });
  const nextCursor = isRecord(value.nextCursor)
    && typeof value.nextCursor.timestamp === "number"
    && Number.isFinite(value.nextCursor.timestamp)
    && typeof value.nextCursor.id === "string"
    ? { timestamp: value.nextCursor.timestamp, id: value.nextCursor.id }
    : null;
  return { messages, nextCursor };
}
