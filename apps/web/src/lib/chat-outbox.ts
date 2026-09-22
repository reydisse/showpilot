import type { ChatMessageOptions, MessageType } from "@/lib/adapters/chat-adapter";

export type ChatOutboxStatus = "waiting" | "sending" | "failed";

export interface ChatOutboxItem {
  id: string;
  orgId: string;
  roomId: string;
  senderId?: string;
  senderName: string;
  senderRole?: string;
  text: string;
  type: MessageType;
  options?: ChatMessageOptions;
  createdAt: number;
  status: ChatOutboxStatus;
  error?: string;
}

const PREFIX = "showpilot.chat.outbox.v1";

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function chatOutboxIdentity(userId?: string, guestToken?: string): string {
  if (userId) return `user-${userId}`;
  if (guestToken) return `guest-${shortHash(guestToken)}`;
  return "unscoped";
}

export function chatOutboxStorageKey(identity: string, orgId: string, roomId: string): string {
  return `${PREFIX}:${encodeURIComponent(identity)}:${encodeURIComponent(orgId)}:${encodeURIComponent(roomId)}`;
}

function isOutboxItem(value: unknown, orgId: string, roomId: string): value is ChatOutboxItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ChatOutboxItem>;
  return item.orgId === orgId
    && item.roomId === roomId
    && typeof item.id === "string"
    && item.id.length <= 64
    && typeof item.senderName === "string"
    && typeof item.text === "string"
    && typeof item.createdAt === "number"
    && (item.type === "text" || item.type === "alert" || item.type === "cue")
    && (item.status === "waiting" || item.status === "sending" || item.status === "failed");
}

export function readChatOutbox(identity: string, orgId: string, roomId: string): ChatOutboxItem[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(chatOutboxStorageKey(identity, orgId, roomId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ChatOutboxItem => isOutboxItem(item, orgId, roomId)).slice(-50).map((item) => item.status === "sending" ? { ...item, status: "waiting" } : item);
  } catch {
    return [];
  }
}

export function writeChatOutbox(identity: string, orgId: string, roomId: string, items: ChatOutboxItem[]): void {
  if (typeof localStorage === "undefined") return;
  const key = chatOutboxStorageKey(identity, orgId, roomId);
  try {
    if (items.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(items.slice(-50)));
  } catch {
    // A full or unavailable browser store must not break live chat.
  }
}
