import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatAdapter, ChatAttachment, ChatMessage, ChatMessageOptions, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
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
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  resetUnread: () => void;
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
  const adapterRef = useRef<ChatAdapter | null>(null);
  const isVisibleRef = useRef(isVisible);

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
    setConnectionStatus("disconnected");

    const effectiveAdapter = roomId === "production" ? chatAdapter : "native";
    const adapter = createAdapter(orgId, effectiveAdapter, guestToken && userName ? { token: guestToken, name: userName } : undefined, roomId);
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

    // Connect
    adapter.connect().catch(() => {
      // Adapter handles reconnection/error internally
    });

    return () => {
      unsubMessage();
      unsubStatus?.();
      adapter.disconnect();
      adapterRef.current = null;
    };
  }, [orgId, chatAdapter, guestToken, roomId, userName]);

  const sendMessage = useCallback(
    (text: string, type: MessageType = "text", options?: ChatMessageOptions) => {
      if (!adapterRef.current || (!text.trim() && !options?.attachments?.length)) return;

      const name = userName || "Operator";
      const role = userRole || "Operator";

      const usesNativeAdapter = roomId !== "production" || chatAdapter === "native";
      if (!usesNativeAdapter && options) {
        const replyPrefix = options.replyTo
          ? `↪ Replying to ${options.replyTo.senderName}: “${options.replyTo.text.slice(0, 100)}”\n`
          : "";
        const attachmentLinks = options.attachments?.map((attachment) => attachment.url).join("\n") ?? "";
        adapterRef.current.sendMessage([replyPrefix + text.trim(), attachmentLinks].filter(Boolean).join("\n"), type, name, role);
      } else {
        adapterRef.current.sendMessage(text.trim(), type, name, role, options);
      }
      if (orgSlug && !guestToken) {
        void import("@/lib/chat-collaboration").then(({ notifyChatMessage }) => notifyChatMessage({
          data: { orgId, orgSlug, roomId, text: text.trim(), mentionedUserIds: options?.mentionedUserIds },
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

  return {
    messages,
    sendMessage,
    uploadAttachment,
    editMessage,
    deleteMessage,
    connectionStatus,
    unreadCount,
    resetUnread,
  };
}
