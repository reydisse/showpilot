import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createBrowserId } from "@/lib/browser-id";
import type { ChatAdapter, ChatAttachment, ChatGatewayStatus, ChatMessage, ChatMessageOptions, ChatTypingState, ConnectionStatus, MessageType } from "@/lib/adapters/chat-adapter";
import { NativeChatAdapter } from "@/lib/adapters/native-chat-adapter";
import { chatOutboxIdentity } from "@/lib/chat-outbox";

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
  currentUserId?: string;
}

interface UseChatReturn {
  guestAccessRevoked: boolean;
  messages: ChatMessage[];
  sendMessage: (text: string, type?: MessageType, options?: ChatMessageOptions) => void;
  uploadAttachment: (file: File) => Promise<ChatAttachment>;
  discardAttachment: (attachment: ChatAttachment) => Promise<void>;
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
  hydrated: boolean;
  openingReadThrough: number | null;
  markRead: (readAt: number) => void;
  gatewayStatus: ChatGatewayStatus;
  hasOlderMessages: boolean;
  loadingOlderMessages: boolean;
  olderMessagesError: string | null;
  loadOlderMessages: () => Promise<void>;
  retryQueuedMessage: (messageId: string) => void;
  cancelQueuedMessage: (messageId: string) => void;
}

function createAdapter(orgId: string, guest: ConstructorParameters<typeof NativeChatAdapter>[1], roomId: string, identity: string, currentUserId?: string): ChatAdapter {
  return new NativeChatAdapter(orgId, guest, roomId, identity, currentUserId);
}

type ChatView = Pick<UseChatReturn,
  "guestAccessRevoked" | "messages" | "connectionStatus" | "unreadCount" |
  "typingUsers" | "readReceipts" | "hydrated" | "openingReadThrough" |
  "gatewayStatus" | "hasOlderMessages" | "loadingOlderMessages" | "olderMessagesError">;

function emptyView(enabled: boolean): ChatView {
  return {
    guestAccessRevoked: false, messages: [], connectionStatus: enabled ? "connecting" : "disconnected",
    unreadCount: 0, typingUsers: [], readReceipts: {}, hydrated: false, openingReadThrough: null,
    gatewayStatus: { platform: null, status: enabled ? "connecting" : "disabled" },
    hasOlderMessages: false, loadingOlderMessages: false, olderMessagesError: null,
  };
}

/** Each connection owns its view, including asynchronous history and callbacks. */
export function useChat({ orgId, isVisible = false, senderName: userName, senderRole: userRole, guestToken, roomId = "production", currentUserId }: UseChatOptions): UseChatReturn {
  const scope = JSON.stringify([orgId, roomId, currentUserId, guestToken, userName]);
  const owner = useMemo(() => ({ scope }), [scope]);
  const [stored, setStored] = useState(() => ({ owner, view: emptyView(Boolean(orgId)) }));
  // A room change must not render even one frame of the previous conversation.
  const view = stored.owner === owner ? stored.view : emptyView(Boolean(orgId));
  const { messages, hasOlderMessages, loadingOlderMessages } = view;
  const adapterRef = useRef<{ owner: typeof owner; adapter: ChatAdapter } | null>(null);
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const getAdapter = useCallback(() => adapterRef.current?.owner === owner ? adapterRef.current.adapter : null, [owner]);
  const update = useCallback((adapter: ChatAdapter, change: (current: ChatView) => ChatView) => {
    setStored(current => adapterRef.current?.adapter === adapter && current.owner === owner
      ? { owner, view: change(current.view) } : current);
  }, [owner]);

  useEffect(() => {
    setStored({ owner, view: emptyView(Boolean(orgId)) });
    if (!orgId) return;
    const adapter = createAdapter(orgId, guestToken && userName ? {
      token: guestToken, name: userName,
      onRevoked: () => update(adapter, current => ({ ...current, guestAccessRevoked: true })),
    } : undefined, roomId, chatOutboxIdentity(currentUserId, guestToken), currentUserId);
    adapterRef.current = { owner, adapter };
    const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubMessage = adapter.onMessage(message => update(adapter, current => {
      const byId = new Map(current.messages.map(item => [item.id, item]));
      byId.set(message.id, message);
      return { ...current,
        messages: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)),
        unreadCount: isVisibleRef.current ? 0 : current.unreadCount + 1,
      };
    }));
    const unsubStatus = adapter.onStatusChange?.(connectionStatus => update(adapter, current => ({ ...current, connectionStatus })));
    const unsubTyping = adapter.onTyping?.(state => {
      const key = state.userId || `name:${state.name}`;
      clearTimeout(typingTimers.get(key));
      const remove = (current: ChatTypingState[]) => current.filter(item => (item.userId || `name:${item.name}`) !== key);
      update(adapter, current => ({ ...current, typingUsers: state.typing ? [...remove(current.typingUsers), state] : remove(current.typingUsers) }));
      if (state.typing) {
        typingTimers.set(key, setTimeout(() => {
          update(adapter, current => ({ ...current, typingUsers: remove(current.typingUsers) }));
          typingTimers.delete(key);
        }, 3500));
      } else typingTimers.delete(key);
    });
    const unsubReadReceipt = adapter.onReadReceipt?.(({ userId, readAt }) => update(adapter, current => ({
      ...current, readReceipts: { ...current.readReceipts, [userId]: Math.max(current.readReceipts[userId] || 0, readAt) },
    })));
    const unsubHydrated = adapter.onHydrated?.(({ readReceipts }) => update(adapter, current => ({
      ...current, openingReadThrough: currentUserId ? readReceipts[currentUserId] ?? null : null,
      hydrated: true, hasOlderMessages: true,
    })));
    const unsubGatewayStatus = adapter.onGatewayStatus?.(gatewayStatus => update(adapter, current => ({ ...current, gatewayStatus })));
    const unsubOutbox = adapter.onOutboxChange?.(pending => update(adapter, current => ({
      ...current, messages: [...current.messages.filter(message => !message.delivery), ...pending]
        .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)),
    })));
    void adapter.connect().catch(() => { /* Adapter reports errors and manages reconnects. */ });
    return () => {
      adapterRef.current = null;
      unsubMessage(); unsubStatus?.(); unsubTyping?.(); unsubReadReceipt?.();
      unsubHydrated?.(); unsubGatewayStatus?.(); unsubOutbox?.();
      for (const timer of typingTimers.values()) clearTimeout(timer);
      adapter.disconnect();
    };
  }, [currentUserId, guestToken, orgId, roomId, owner, update, userName]);

  useEffect(() => {
    const adapter = getAdapter();
    if (isVisible && adapter) update(adapter, current => ({ ...current, unreadCount: 0 }));
  }, [getAdapter, isVisible, update]);

  const sendMessage = useCallback(
    (text: string, type: MessageType = "text", options?: ChatMessageOptions) => {
      const adapter = getAdapter();
      if (!adapter || (!text.trim() && !options?.attachments?.length && !options?.poll)) return;

      const name = userName || "Operator";
      const role = userRole || "Operator";
      const clientMessageId = createBrowserId();
      const messageOptions = { ...options, clientMessageId };
      void adapter.sendMessage(text.trim(), type, name, role, messageOptions);
      if (!guestToken) {
        void import("@/lib/chat-collaboration").then(({ notifyChatMessage }) => notifyChatMessage({
          data: { orgId, roomId, text: text.trim() || messageOptions?.poll?.question || "", mentionedUserIds: messageOptions?.mentionedUserIds, messageId: clientMessageId },
        })).catch(() => undefined);
      }
    },
    [getAdapter, guestToken, orgId, roomId, userName, userRole],
  );

  const editMessage = useCallback(async (messageId: string, text: string) => {
    await getAdapter()?.editMessage?.(messageId, text);
  }, [getAdapter]);

  const deleteMessage = useCallback(async (messageId: string) => {
    await getAdapter()?.deleteMessage?.(messageId);
  }, [getAdapter]);

  const votePoll = useCallback(async (messageId: string, optionId: string) => {
    await getAdapter()?.votePoll?.(messageId, optionId);
  }, [getAdapter]);

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    const adapter = getAdapter();
    if (!adapter?.toggleReaction) throw new Error("Reactions are available in ShowPilot chat");
    await adapter.toggleReaction(messageId, emoji);
    const target = messages.find((message) => message.id === messageId);
    if (target?.senderId) {
      const { notifyChatReaction } = await import("@/lib/chat-collaboration");
      await notifyChatReaction({ data: { orgId, roomId, messageId, targetUserId: target.senderId, emoji } });
    }
  }, [getAdapter, messages, orgId, roomId]);

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

  const discardAttachment = useCallback(async (attachment: ChatAttachment): Promise<void> => {
    const target = new URL(attachment.url, window.location.origin);
    if (guestToken) target.searchParams.set("guestToken", guestToken);
    const response = await fetch(target, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      const message = await response.text().catch(() => "");
      throw new Error(message || "Attachment could not be removed");
    }
  }, [guestToken]);

  const resetUnread = useCallback(() => {
    const adapter = getAdapter();
    if (adapter) update(adapter, current => ({ ...current, unreadCount: 0 }));
  }, [getAdapter, update]);
  const setTyping = useCallback((typing: boolean) => { getAdapter()?.setTyping?.(typing); }, [getAdapter]);
  const markRead = useCallback((readAt: number) => { getAdapter()?.markRead?.(readAt); }, [getAdapter]);
  const loadOlderMessages = useCallback(async () => {
    const adapter = getAdapter();
    if (!adapter?.loadOlder || loadingOlderMessages || !hasOlderMessages) return;
    update(adapter, current => ({ ...current, loadingOlderMessages: true, olderMessagesError: null }));
    try {
      const page = await adapter.loadOlder(100);
      update(adapter, current => {
        const pending = current.messages.filter(message => message.delivery);
        const settled = current.messages.filter(message => !message.delivery);
        const byId = new Map([...page.messages, ...settled].map(message => [message.id, message]));
        return { ...current, hasOlderMessages: page.nextCursor !== null,
          messages: [...byId.values(), ...pending].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)),
        };
      });
    } catch (error) {
      update(adapter, current => ({ ...current, olderMessagesError: error instanceof Error ? error.message : "Older messages could not be loaded." }));
    } finally {
      update(adapter, current => ({ ...current, loadingOlderMessages: false }));
    }
  }, [getAdapter, hasOlderMessages, loadingOlderMessages, update]);
  const retryQueuedMessage = useCallback((messageId: string) => getAdapter()?.retryOutbox?.(messageId), [getAdapter]);
  const cancelQueuedMessage = useCallback((messageId: string) => getAdapter()?.cancelOutbox?.(messageId), [getAdapter]);

  return {
    ...view, sendMessage, uploadAttachment, discardAttachment, editMessage, deleteMessage, votePoll,
    toggleReaction, resetUnread, setTyping, markRead, loadOlderMessages, retryQueuedMessage, cancelQueuedMessage,
  };
}
