import { useState, useEffect, useRef, useCallback } from "react";
import type { ChatMessage, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
import { NativeChatAdapter } from "@/lib/adapters/native-chat-adapter";

interface UseChatOptions {
  orgId: string;
  /** When true, the chat panel is visible and unread count resets */
  isVisible?: boolean;
}

interface UseChatReturn {
  messages: ChatMessage[];
  sendMessage: (text: string, type?: MessageType) => void;
  connectionStatus: ConnectionStatus;
  unreadCount: number;
  resetUnread: () => void;
}

/**
 * useChat — React hook for the ShowPilot chat system.
 *
 * Creates the native chat adapter (future: checks org settings for
 * external integration). Manages WebSocket lifecycle, message state,
 * reconnection, and unread tracking.
 */
export function useChat({ orgId, isVisible = false }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [unreadCount, setUnreadCount] = useState(0);
  const adapterRef = useRef<NativeChatAdapter | null>(null);
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

    const adapter = new NativeChatAdapter(orgId);
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
    const unsubStatus = adapter.onStatusChange((status: ConnectionStatus) => {
      setConnectionStatus(status);
    });

    // Connect
    adapter.connect().catch(() => {
      // Adapter handles reconnection internally
    });

    return () => {
      unsubMessage();
      unsubStatus();
      adapter.disconnect();
      adapterRef.current = null;
    };
  }, [orgId]);

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
