export interface MobileChatMessage {
  id: string;
  senderId?: string;
  senderName: string;
  senderRole?: string;
  text: string;
  type: "text" | "alert" | "cue" | "system";
  timestamp: number;
  editedAt?: number;
  deletedAt?: number;
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
  return {
    id: value.id,
    senderName: value.senderName,
    text: value.text,
    type: value.type,
    timestamp: value.timestamp,
    ...(typeof value.senderId === "string" ? { senderId: value.senderId } : {}),
    ...(typeof value.senderRole === "string" ? { senderRole: value.senderRole } : {}),
    ...(typeof value.editedAt === "number" && Number.isFinite(value.editedAt) ? { editedAt: value.editedAt } : {}),
    ...(typeof value.deletedAt === "number" && Number.isFinite(value.deletedAt) ? { deletedAt: value.deletedAt } : {}),
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
