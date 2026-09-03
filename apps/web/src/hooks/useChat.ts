import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserId } from "@/lib/browser-id";
import type { ChatAdapter, ChatAttachment, ChatGatewayStatus, ChatMessage, ChatMessageOptions, ChatTypingState, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
import { NativeChatAdapter } from "@/lib/adapters/native-chat-adapter";

interface UseChatOptions {
  orgId: string;
  /** When true, the chat panel is visible and unread count resets */
  isVisible?: boolean;
  /** Display name for the current user */
  senderName?: string;
  /** Role of the current user (e.g. "admin", "td", "operator") */
  senderRole?: string;
  guestToken?: string;
  roomId?: string;
}

interface UseChatReturn {
  messages: ChatMessage[];
  sendMessage: (text: string, type?: MessageType, options?: ChatMessageOptions) => void;
  uploadAttachment: (file: File) => Promise<ChatAttachment>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  votePoll: (messageId: string, optionId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  resetUnread: () => void;
  typingUsers: ChatTypingState[];
  setTyping: (typing: boolean) => void;
  readReceipts: Record<string, number>;
  gatewayStatus: ChatGatewayStatus;
}

function createAdapter(orgId: string, guest?: { token: string; name: string }, roomId = "production"): ChatAdapter {
  return new NativeChatAdapter(orgId, guest, roomId);
}

/**
 * useChat — React hook for the ShowPilot chat system.
 *
 * Every client connects to the ShowPilot chat relay. The relay owns any
 * configured external-platform gateway so web, Desktop, and mobile always
 * share one ordered conversation.
 */
export function useChat({ orgId, isVisible = false, senderName: userName, senderRole: userRole, guestToken, roomId = "production" }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [unreadCount, setUnreadCount] = useState(0);
  const [typingUsers, setTypingUsers] = useState<ChatTypingState[]>([]);
  const [readReceipts, setReadReceipts] = useState<Record<string, number>>({});
  const [gatewayStatus, setGatewayStatus] = useState<ChatGatewayStatus>({ platform: null, status: "disabled" });
  const adapterRef = useRef<ChatAdapter | null>(null);
  const isVisibleRef = useRef(isVisible);
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Keep the ref in sync
  isVisibleRef.current = isVisible;

  // Reset unread when panel becomes visible
  useEffect(() => {
    if (isVisible) {
      setUnreadCount(0);
    }
  }, [isVisible]);

  // Create adapter and manage lifecycle
  useEffect(() => {
    if (!orgId) return;

    // Clear state when the organization, room, or guest identity changes.
    setMessages([]);
    setTypingUsers([]);
    setReadReceipts({});
    setGatewayStatus({ platform: null, status: "connecting" });
    setConnectionStatus("disconnected");

    const adapter = createAdapter(orgId, guestToken && userName ? { token: guestToken, name: userName } : undefined, roomId);
    adapterRef.current = adapter;

    // Subscribe to messages
    const unsubMessage = adapter.onMessage((message: ChatMessage) => {
      setMessages((prev) => {
        // Deduplicate by id
        const existingIndex = prev.findIndex((m) => m.id === message.id);
        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = message;
          return next;
        }
        return [...prev, message];
      });

      // Increment unread if panel is not visible
      if (!isVisibleRef.current) {
        setUnreadCount((c) => c + 1);
      }
    });
    // Subscribe to status changes
    const unsubStatus = adapter.onStatusChange?.((status: ConnectionStatus) => {
      setConnectionStatus(status);
    });

    const handleTyping = (state: ChatTypingState) => {
      const key = state.userId || `name:${state.name}`;
      const currentTimer = typingTimersRef.current.get(key);
      if (currentTimer) clearTimeout(currentTimer);
      setTypingUsers((current) => state.typing
        ? [...current.filter((item) => (item.userId || `name:${item.name}`) !== key), state]
        : current.filter((item) => (item.userId || `name:${item.name}`) !== key));
      if (state.typing) {
        typingTimersRef.current.set(key, setTimeout(() => {
          setTypingUsers((current) => current.filter((item) => (item.userId || `name:${item.name}`) !== key));
          typingTimersRef.current.delete(key);
        }, 3500));
      } else {
        typingTimersRef.current.delete(key);
      }
    };
    const unsubTyping = adapter.onTyping?.(handleTyping);

    const unsubReadReceipt = adapter.onReadReceipt?.(({ userId, readAt }) => {
      setReadReceipts((current) => ({ ...current, [userId]: Math.max(current[userId] || 0, readAt) }));
    });
    const unsubGatewayStatus = adapter.onGatewayStatus?.(setGatewayStatus);

    // Connect
    adapter.connect().catch(() => {
      // Adapter handles reconnection/error internally
    });

    return () => {
      unsubMessage();
      unsubStatus?.();
      unsubTyping?.();
      unsubReadReceipt?.();
      unsubGatewayStatus?.();
      for (const timer of typingTimersRef.current.values()) clearTimeout(timer);
      typingTimersRef.current.clear();
      adapter.disconnect();
      adapterRef.current = null;
    };
  }, [orgId, guestToken, roomId, userName]);

  useEffect(() => {
    if (!isVisible || !roomId.startsWith("dm:") || messages.length === 0) return;
    const latestTimestamp = messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0);
    adapterRef.current?.markRead?.(latestTimestamp);
  }, [isVisible, messages, roomId]);

  const sendMessage = useCallback(
    (text: string, type: MessageType = "text", options?: ChatMessageOptions) => {
      if (!adapterRef.current || (!text.trim() && !options?.attachments?.length && !options?.poll)) return;

      const name = userName || "Operator";
      const role = userRole || "Operator";
      const clientMessageId = createBrowserId();
      const messageOptions = { ...options, clientMessageId };
      void adapterRef.current.sendMessage(text.trim(), type, name, role, messageOptions);
      if (!guestToken) {
        void import("@/lib/chat-collaboration").then(({ notifyChatMessage }) => notifyChatMessage({
          data: { orgId, roomId, text: text.trim() || messageOptions?.poll?.question || "", mentionedUserIds: messageOptions?.mentionedUserIds, messageId: clientMessageId },
        })).catch(() => undefined);
      }
    },
    [guestToken, orgId, roomId, userName, userRole],
  );

  const editMessage = useCallback(async (messageId: string, text: string) => {
    await adapterRef.current?.editMessage?.(messageId, text);
  }, []);

  const deleteMessage = useCallback(async (messageId: string) => {
    await adapterRef.current?.deleteMessage?.(messageId);
  }, []);

  const votePoll = useCallback(async (messageId: string, optionId: string) => {
    await adapterRef.current?.votePoll?.(messageId, optionId);
  }, []);

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    const adapter = adapterRef.current;
    if (!adapter?.toggleReaction) throw new Error("Reactions are available in ShowPilot chat");
    await adapter.toggleReaction(messageId, emoji);
    const target = messages.find((message) => message.id === messageId);
    if (target?.senderId) {
      const { notifyChatReaction } = await import("@/lib/chat-collaboration");
      await notifyChatReaction({ data: { orgId, roomId, messageId, targetUserId: target.senderId, emoji } });
    }
  }, [messages, orgId, roomId]);

  const uploadAttachment = useCallback(async (file: File): Promise<ChatAttachment> => {
    const formData = new FormData();
    formData.set("file", file);
    const params = new URLSearchParams({ room: roomId });
    if (guestToken) params.set("guestToken", guestToken);
    const response = await fetch(`/api/chat/${encodeURIComponent(orgId)}/upload?${params}`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Upload failed");
    }
    return response.json() as Promise<ChatAttachment>;
  }, [guestToken, orgId, roomId]);

  const resetUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  const setTyping = useCallback((typing: boolean) => {
    adapterRef.current?.setTyping?.(typing);
  }, []);

  return {
    messages,
    sendMessage,
    uploadAttachment,
    editMessage,
    deleteMessage,
    votePoll,
    toggleReaction,
    connectionStatus,
    unreadCount,
    resetUnread,
    typingUsers,
    setTyping,
    readReceipts,
    gatewayStatus,
  };
}
