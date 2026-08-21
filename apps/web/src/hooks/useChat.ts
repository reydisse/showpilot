import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatAdapter, ChatAttachment, ChatMessage, ChatMessageOptions, ChatTypingState, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
import type { ChatAdapterType } from "@/lib/settings";
import { NativeChatAdapter } from "@/lib/adapters/native-chat-adapter";
import { MattermostChatAdapter } from "@/lib/adapters/mattermost-chat-adapter";
import { SlackChatAdapter } from "@/lib/adapters/slack-chat-adapter";
import { TeamsChatAdapter } from "@/lib/adapters/teams-chat-adapter";
import { DiscordChatAdapter } from "@/lib/adapters/discord-chat-adapter";

interface UseChatOptions {
  orgId: string;
  /** When true, the chat panel is visible and unread count resets */
  isVisible?: boolean;
  /** Which adapter to use — defaults to "native" */
  chatAdapter?: ChatAdapterType;
  /** Display name for the current user */
  senderName?: string;
  /** Role of the current user (e.g. "admin", "td", "operator") */
  senderRole?: string;
  guestToken?: string;
  roomId?: string;
  orgSlug?: string;
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
}

function createAdapter(orgId: string, type: ChatAdapterType, guest?: { token: string; name: string }, roomId = "production"): ChatAdapter {
  switch (type) {
    case "mattermost":
      return new MattermostChatAdapter(orgId);
    case "slack":
      return new SlackChatAdapter(orgId);
    case "teams":
      return new TeamsChatAdapter(orgId);
    case "discord":
      return new DiscordChatAdapter(orgId);
    default:
      return new NativeChatAdapter(orgId, guest, roomId);
  }
}

/**
 * useChat — React hook for the ShowPilot chat system.
 *
 * Creates the appropriate chat adapter based on org settings.
 * Manages connection lifecycle, message state, and unread tracking.
 */
export function useChat({ orgId, isVisible = false, chatAdapter = "native", senderName: userName, senderRole: userRole, guestToken, roomId = "production", orgSlug }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [unreadCount, setUnreadCount] = useState(0);
  const [typingUsers, setTypingUsers] = useState<ChatTypingState[]>([]);
  const [readReceipts, setReadReceipts] = useState<Record<string, number>>({});
  const adapterRef = useRef<ChatAdapter | null>(null);
  const pollAdapterRef = useRef<NativeChatAdapter | null>(null);
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

    // Clear previous messages when switching adapters
    setMessages([]);
    setTypingUsers([]);
    setReadReceipts({});
    setConnectionStatus("disconnected");

    const effectiveAdapter = roomId === "production" ? chatAdapter : "native";
    const adapter = createAdapter(orgId, effectiveAdapter, guestToken && userName ? { token: guestToken, name: userName } : undefined, roomId);
    adapterRef.current = adapter;
    const pollAdapter = effectiveAdapter !== "native" ? new NativeChatAdapter(orgId, undefined, roomId) : null;
    pollAdapterRef.current = pollAdapter;

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
    const unsubPollMessage = pollAdapter?.onMessage((message) => {
      // External-chat members also keep a native sidecar open so QR guests
      // and native-only features can share the same visible conversation.
      // Member messages mirrored into native are ignored here because the
      // external adapter already delivers them to this UI.
      if (!message.poll && message.senderRole !== "Guest") return;
      setMessages((current) => {
        const index = current.findIndex((item) => item.id === message.id);
        if (index < 0) return [...current, message];
        const next = [...current]; next[index] = message; return next;
      });
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
    const unsubPollTyping = pollAdapter?.onTyping?.(handleTyping);

    const unsubReadReceipt = adapter.onReadReceipt?.(({ userId, readAt }) => {
      setReadReceipts((current) => ({ ...current, [userId]: Math.max(current[userId] || 0, readAt) }));
    });

    // Connect
    adapter.connect().catch(() => {
      // Adapter handles reconnection/error internally
    });
    pollAdapter?.connect().catch(() => undefined);

    return () => {
      unsubMessage();
      unsubStatus?.();
      unsubPollMessage?.();
      unsubTyping?.();
      unsubPollTyping?.();
      unsubReadReceipt?.();
      for (const timer of typingTimersRef.current.values()) clearTimeout(timer);
      typingTimersRef.current.clear();
      adapter.disconnect();
      pollAdapter?.disconnect();
      adapterRef.current = null;
      pollAdapterRef.current = null;
    };
  }, [orgId, chatAdapter, guestToken, roomId, userName]);

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

      const nativeSidecar = pollAdapterRef.current;
      const usesNativeAdapter = roomId !== "production" || chatAdapter === "native";
      const clientMessageId = usesNativeAdapter ? crypto.randomUUID() : undefined;
      const messageOptions = clientMessageId ? { ...options, clientMessageId } : options;
      if (messageOptions?.poll && nativeSidecar) {
        void nativeSidecar.sendMessage(text.trim(), type, name, role, messageOptions);
      } else {
        if (!usesNativeAdapter && messageOptions) {
          const replyPrefix = messageOptions.replyTo
            ? `↪ Replying to ${messageOptions.replyTo.senderName}: “${messageOptions.replyTo.text.slice(0, 100)}”\n`
            : "";
          const attachmentLinks = messageOptions.attachments?.map((attachment) => attachment.url).join("\n") ?? "";
          adapterRef.current.sendMessage([replyPrefix + text.trim(), attachmentLinks].filter(Boolean).join("\n"), type, name, role);
        } else {
          adapterRef.current.sendMessage(text.trim(), type, name, role, messageOptions);
        }
        // Mirror external-adapter member messages into the native room used
        // by temporary QR crew. The sidecar listener filters this sender's
        // mirror, avoiding a duplicate beside the external adapter's echo.
        if (nativeSidecar) {
          void nativeSidecar.sendMessage(text.trim(), type, name, role, messageOptions);
        }
      }
      if (orgSlug && !guestToken) {
        void import("@/lib/chat-collaboration").then(({ notifyChatMessage }) => notifyChatMessage({
          data: { orgId, orgSlug, roomId, text: text.trim() || messageOptions?.poll?.question || "", mentionedUserIds: messageOptions?.mentionedUserIds, messageId: clientMessageId },
        })).catch(() => undefined);
      }
    },
    [chatAdapter, guestToken, orgId, orgSlug, roomId, userName, userRole],
  );

  const editMessage = useCallback(async (messageId: string, text: string) => {
    await adapterRef.current?.editMessage?.(messageId, text);
  }, []);

  const deleteMessage = useCallback(async (messageId: string) => {
    await adapterRef.current?.deleteMessage?.(messageId);
  }, []);

  const votePoll = useCallback(async (messageId: string, optionId: string) => {
    await (pollAdapterRef.current ?? adapterRef.current)?.votePoll?.(messageId, optionId);
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
    pollAdapterRef.current?.setTyping?.(typing);
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
  };
}
