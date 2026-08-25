import { useCallback, useEffect, useRef, useState } from "react";
import { fetch as expoFetch } from "expo/fetch";
import { AppState } from "react-native";
import { authClient } from "@/lib/auth-client";
import {
  compareChatMessages,
  mergeChatMessage,
  parseChatHistoryPage,
  parseChatMessage,
  type ChatHistoryCursor,
  type MobileChatMessage,
} from "@/lib/chat-history";
import { SHOWPILOT_URL } from "@/lib/env";

export type { MobileChatMessage } from "@/lib/chat-history";

type Status = "connecting" | "connected" | "reconnecting" | "offline";

type NativeWebSocketConstructor = new (
  uri: string,
  protocols?: string | string[] | null,
  options?: { headers: Record<string, string> } | null,
) => WebSocket;

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
  const socketRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<string[]>([]);

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
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    setMessages([]);
    setHistoryCursor(null);
    setHasOlder(false);
    queueRef.current = [];

    function reconnect() {
      if (disposed || reconnectTimer || AppState.currentState !== "active") return;
      setStatus("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, Math.min(1_000 * 2 ** attempts++, 30_000));
    }

    function connect() {
      if (disposed || AppState.currentState !== "active") return;
      const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
      const socket = new NativeWebSocket(chatUrl(activeOrgId, roomId), null, { headers: { Cookie: authClient.getCookie() } });
      socketRef.current = socket;
      setStatus(attempts ? "reconnecting" : "connecting");
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
          } else if ("type" in payload && (payload.type === "message" || payload.type === "message-edited" || payload.type === "message-deleted")) {
            const message = "message" in payload ? parseChatMessage(payload.message) : null;
            if (message) setMessages((current) => mergeChatMessage(current, message));
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
        reconnect();
      };
    }

    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") connect();
      else {
        setStatus("offline");
        socketRef.current?.close();
      }
    });
    connect();
    return () => {
      disposed = true;
      appState.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      // Never carry an offline message across a room or organization boundary.
      queueRef.current = [];
      socket?.close();
    };
  }, [flush, orgId, roomId]);

  const send = useCallback((text: string, messageType: MobileChatMessage["type"] = "text") => {
    const clean = text.trim().slice(0, 4_000);
    if (!clean) return false;
    const frame = JSON.stringify({ type: "message", text: clean, messageType });
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
    else queueRef.current.push(frame);
    return true;
  }, []);

  const loadOlder = useCallback(async () => {
    if (!orgId || !historyCursor || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    try {
      const response = await expoFetch(historyUrl(orgId, roomId, historyCursor), {
        headers: { Accept: "application/json", Cookie: authClient.getCookie() },
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

  return { messages, status, lastError, send, hasOlder, loadingOlder, loadOlder };
}
