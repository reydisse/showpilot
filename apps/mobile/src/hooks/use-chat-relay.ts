import { useCallback, useEffect, useRef, useState } from "react";
import { fetch as expoFetch } from "expo/fetch";
import { AppState } from "react-native";
import {
  createAuthenticatedWebSocket,
  getAuthenticatedFetchCredentials,
  getNativeCookieHeader,
} from "@/lib/auth-transport";
import {
  compareChatMessages,
  mergeChatMessage,
  parseChatHistoryPage,
  parseChatMessage,
  type ChatHistoryCursor,
  type MobileChatMessage,
  type MobileChatReactionEmoji,
} from "@/lib/chat-history";
import { SHOWPILOT_URL } from "@/lib/env";

export type { MobileChatMessage } from "@/lib/chat-history";

type Status = "connecting" | "connected" | "reconnecting" | "offline";

export interface MobileChatSendOptions {
  replyTo?: NonNullable<MobileChatMessage["replyTo"]>;
  attachments?: NonNullable<MobileChatMessage["attachments"]>;
  poll?: { question: string; options: string[] };
}

export interface MobileChatTypingState {
  userId?: string;
  name: string;
  typing: boolean;
}

interface PendingMutation {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createChatRequestId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function chatUrl(orgId: string, roomId: string) {
  const url = new URL(SHOWPILOT_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/chat/${encodeURIComponent(orgId)}/ws`;
  url.search = new URLSearchParams({ room: roomId }).toString();
  return url.toString();
}

function historyUrl(orgId: string, roomId: string, cursor: ChatHistoryCursor) {
  const url = new URL(SHOWPILOT_URL);
  url.pathname = `/api/chat/${encodeURIComponent(orgId)}/history`;
  url.search = new URLSearchParams({
    room: roomId,
    limit: "200",
    beforeTimestamp: String(cursor.timestamp),
    beforeId: cursor.id,
  }).toString();
  return url.toString();
}

export function useChatRelay(orgId: string | undefined, roomId = "production") {
  const [messages, setMessages] = useState<MobileChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<ChatHistoryCursor | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [typingUsers, setTypingUsers] = useState<MobileChatTypingState[]>([]);
  const [readReceipts, setReadReceipts] = useState<Record<string, number>>({});
  const socketRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<string[]>([]);
  const pendingMutationsRef = useRef(new Map<string, PendingMutation>());
  const typingTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const flush = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (queueRef.current.length) {
      const frame = queueRef.current.shift();
      if (frame !== undefined) socket.send(frame);
    }
  }, []);

  useEffect(() => {
    if (!orgId) return;
    const activeOrgId = orgId;
    let disposed = false;
    let connecting = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    setMessages([]);
    setHistoryCursor(null);
    setHasOlder(false);
    setTypingUsers([]);
    setReadReceipts({});
    queueRef.current = [];

    function rejectPendingMutations(message: string) {
      for (const pending of pendingMutationsRef.current.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(message));
      }
      pendingMutationsRef.current.clear();
    }

    function updateTypingUser(state: MobileChatTypingState) {
      const key = state.userId || `name:${state.name}`;
      const timer = typingTimersRef.current.get(key);
      if (timer) clearTimeout(timer);
      setTypingUsers((current) => state.typing
        ? [...current.filter((candidate) => (candidate.userId || `name:${candidate.name}`) !== key), state]
        : current.filter((candidate) => (candidate.userId || `name:${candidate.name}`) !== key));
      if (state.typing) {
        typingTimersRef.current.set(key, setTimeout(() => {
          setTypingUsers((current) => current.filter((candidate) => (candidate.userId || `name:${candidate.name}`) !== key));
          typingTimersRef.current.delete(key);
        }, 3_500));
      } else {
        typingTimersRef.current.delete(key);
      }
    }

    function reconnect() {
      if (disposed || reconnectTimer || AppState.currentState !== "active") return;
      setStatus("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, Math.min(1_000 * 2 ** attempts++, 30_000));
    }

    async function connect() {
      if (disposed || connecting || AppState.currentState !== "active") return;
      const existingSocket = socketRef.current;
      if (existingSocket?.readyState === WebSocket.CONNECTING || existingSocket?.readyState === WebSocket.OPEN) return;
      connecting = true;
      setStatus(attempts ? "reconnecting" : "connecting");
      let socket: WebSocket;
      try {
        socket = await createAuthenticatedWebSocket(chatUrl(activeOrgId, roomId));
      } catch (error) {
        connecting = false;
        if (!disposed) {
          setLastError(error instanceof Error ? error.message : "Chat authentication failed.");
          reconnect();
        }
        return;
      }
      connecting = false;
      if (disposed || AppState.currentState !== "active") {
        socket.close();
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        if (disposed || socketRef.current !== socket) return;
        attempts = 0;
        setStatus("connected");
        setLastError(null);
        flush();
      };
      socket.onmessage = (event) => {
        if (disposed || socketRef.current !== socket || typeof event.data !== "string") return;
        try {
          const payload = JSON.parse(event.data) as unknown;
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
          if ("type" in payload && payload.type === "hydrate" && "messages" in payload && Array.isArray(payload.messages)) {
            const hydratedMessages = payload.messages.flatMap((candidate) => {
              const message = parseChatMessage(candidate);
              return message ? [message] : [];
            });
            setMessages(hydratedMessages);
            const oldest = hydratedMessages[0];
            setHistoryCursor(oldest ? { timestamp: oldest.timestamp, id: oldest.id } : null);
            setHasOlder(hydratedMessages.length >= 2_000);
            if ("readReceipts" in payload && typeof payload.readReceipts === "object" && payload.readReceipts !== null) {
              const receipts: Record<string, number> = {};
              for (const [userId, readAt] of Object.entries(payload.readReceipts)) {
                if (typeof readAt === "number" && Number.isFinite(readAt)) receipts[userId] = readAt;
              }
              setReadReceipts(receipts);
            }
          } else if ("type" in payload && (payload.type === "message" || payload.type === "message-edited" || payload.type === "message-deleted")) {
            const message = "message" in payload ? parseChatMessage(payload.message) : null;
            if (message) setMessages((current) => mergeChatMessage(current, message));
          } else if ("type" in payload && payload.type === "mutation-result" && "requestId" in payload && typeof payload.requestId === "string") {
            const pending = pendingMutationsRef.current.get(payload.requestId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingMutationsRef.current.delete(payload.requestId);
              if ("ok" in payload && payload.ok === true) pending.resolve();
              else pending.reject(new Error("error" in payload && typeof payload.error === "string" ? payload.error : "Message update failed."));
            }
          } else if ("type" in payload && payload.type === "typing"
            && "name" in payload && typeof payload.name === "string"
            && "typing" in payload && typeof payload.typing === "boolean") {
            const userId = "userId" in payload && typeof payload.userId === "string" ? payload.userId : undefined;
            updateTypingUser({
              ...(userId ? { userId } : {}),
              name: payload.name,
              typing: payload.typing,
            });
          } else if ("type" in payload && payload.type === "read-receipt"
            && "userId" in payload && typeof payload.userId === "string"
            && "readAt" in payload && typeof payload.readAt === "number" && Number.isFinite(payload.readAt)) {
            const userId = payload.userId;
            const readAt = payload.readAt;
            setReadReceipts((current) => ({ ...current, [userId]: Math.max(current[userId] ?? 0, readAt) }));
          }
        } catch {
          setLastError("A live chat update could not be read.");
        }
      };
      socket.onerror = () => {
        if (!disposed) setLastError("Chat connection interrupted. Reconnecting…");
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        rejectPendingMutations("Chat disconnected before the update completed.");
        reconnect();
      };
    }

    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") void connect();
      else {
        setStatus("offline");
        socketRef.current?.close();
      }
    });
    void connect();
    const typingTimers = typingTimersRef.current;
    return () => {
      disposed = true;
      appState.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      // Never carry an offline message across a room or organization boundary.
      queueRef.current = [];
      rejectPendingMutations("Chat room changed before the update completed.");
      for (const timer of typingTimers.values()) clearTimeout(timer);
      typingTimers.clear();
      socket?.close();
    };
  }, [flush, orgId, roomId]);

  const send = useCallback((text: string, messageType: MobileChatMessage["type"] = "text", options?: MobileChatSendOptions) => {
    const clean = text.trim().slice(0, 4_000);
    if (!clean && !options?.attachments?.length && !options?.poll) return null;
    const clientMessageId = createChatRequestId();
    const frame = JSON.stringify({
      type: "message",
      text: clean,
      messageType,
      clientMessageId,
      replyTo: options?.replyTo,
      attachments: options?.attachments,
      poll: options?.poll ? {
        question: options.poll.question,
        options: options.poll.options.map((option) => ({ id: "", text: option, voterIds: [] })),
      } : undefined,
    });
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
    else queueRef.current.push(frame);
    return clientMessageId;
  }, []);

  const mutateMessage = useCallback((payload: {
    type: "edit" | "delete" | "vote" | "reaction";
    messageId: string;
    text?: string;
    optionId?: string;
    emoji?: MobileChatReactionEmoji;
  }) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Chat is offline. Reconnect and try again."));
    const requestId = createChatRequestId();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingMutationsRef.current.delete(requestId);
        reject(new Error("The message update timed out. Please try again."));
      }, 8_000);
      pendingMutationsRef.current.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...payload, requestId }));
    });
  }, []);

  const editMessage = useCallback((messageId: string, text: string) => {
    const clean = text.trim().slice(0, 4_000);
    if (!clean) return Promise.reject(new Error("Message cannot be empty."));
    return mutateMessage({ type: "edit", messageId, text: clean });
  }, [mutateMessage]);

  const deleteMessage = useCallback((messageId: string) => mutateMessage({ type: "delete", messageId }), [mutateMessage]);
  const votePoll = useCallback((messageId: string, optionId: string) => mutateMessage({ type: "vote", messageId, optionId }), [mutateMessage]);
  const toggleReaction = useCallback((messageId: string, emoji: MobileChatReactionEmoji) => mutateMessage({ type: "reaction", messageId, emoji }), [mutateMessage]);
  const setTyping = useCallback((typing: boolean) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "typing", typing }));
  }, []);
  const markRead = useCallback((readAt: number) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "read", readAt }));
  }, []);

  useEffect(() => {
    if (!roomId.startsWith("dm:") || messages.length === 0) return;
    const latest = messages.reduce((timestamp, message) => Math.max(timestamp, message.timestamp), 0);
    markRead(latest);
  }, [markRead, messages, roomId]);

  const loadOlder = useCallback(async () => {
    if (!orgId || !historyCursor || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    try {
      const nativeCookieHeader = await getNativeCookieHeader();
      const response = await expoFetch(historyUrl(orgId, roomId, historyCursor), {
        credentials: getAuthenticatedFetchCredentials(),
        headers: { Accept: "application/json", ...nativeCookieHeader },
      });
      if (!response.ok) throw new Error(`Earlier messages could not be loaded (${response.status}).`);
      const payload: unknown = await response.json();
      const page = parseChatHistoryPage(payload);
      if (!page) {
        throw new Error("ShowPilot returned an invalid chat history page.");
      }
      setMessages((current) => {
        const messagesById = new Map<string, MobileChatMessage>();
        for (const message of [...page.messages, ...current]) messagesById.set(message.id, message);
        return [...messagesById.values()].sort(compareChatMessages);
      });
      setHistoryCursor(page.nextCursor);
      setHasOlder(page.nextCursor !== null);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Earlier messages could not be loaded.");
    } finally {
      setLoadingOlder(false);
    }
  }, [hasOlder, historyCursor, loadingOlder, orgId, roomId]);

  return {
    messages,
    status,
    lastError,
    send,
    editMessage,
    deleteMessage,
    votePoll,
    toggleReaction,
    typingUsers,
    setTyping,
    readReceipts,
    hasOlder,
    loadingOlder,
    loadOlder,
  };
}
