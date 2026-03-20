import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatAdapter, ChatMessage, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
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
}

interface UseChatReturn {
  messages: ChatMessage[];
  sendMessage: (text: string, type?: MessageType) => void;
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  resetUnread: () => void;
}

function createAdapter(orgId: string, type: ChatAdapterType): ChatAdapter {
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
      return new NativeChatAdapter(orgId);
  }
}

/**
 * useChat — React hook for the ShowPilot chat system.
 *
 * Creates the appropriate chat adapter based on org settings.
 * Manages connection lifecycle, message state, and unread tracking.
 */
export function useChat({ orgId, isVisible = false, chatAdapter = "native" }: UseChatOptions): UseChatReturn {
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

    const adapter = createAdapter(orgId, chatAdapter);
    adapterRef.current = adapter;

    // Subscribe to messages
    const unsubMessage = adapter.onMessage((message: ChatMessage) => {
      setMessages((prev) => {
        // Deduplicate by id
        if (prev.some((m) => m.id === message.id)) return prev;
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
  }, [orgId, chatAdapter]);

  const sendMessage = useCallback(
    (text: string, type: MessageType = "text") => {
      if (!adapterRef.current || !text.trim()) return;

      // TODO: Pull senderName and senderRole from auth context
      const senderName = "Operator";
      const senderRole = "Operator";

      adapterRef.current.sendMessage(text.trim(), type, senderName, senderRole);
    },
    [],
  );

  const resetUnread = useCallback(() => {
    setUnreadCount(0);
  }, []);

  return {
    messages,
    sendMessage,
    connectionStatus,
    unreadCount,
    resetUnread,
  };
}
