import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";

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

type Status = "connecting" | "connected" | "reconnecting" | "offline";

type NativeWebSocketConstructor = new (
  uri: string,
  protocols?: string | string[] | null,
  options?: { headers: Record<string, string> } | null,
) => WebSocket;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is MobileChatMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.senderName === "string"
    && typeof value.text === "string"
    && typeof value.timestamp === "number";
}

function chatUrl(orgId: string, roomId: string) {
  const url = new URL(SHOWPILOT_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/chat/${encodeURIComponent(orgId)}/ws`;
  url.search = new URLSearchParams({ room: roomId }).toString();
  return url.toString();
}

function mergeMessage(messages: MobileChatMessage[], message: MobileChatMessage) {
  const existing = messages.findIndex((candidate) => candidate.id === message.id);
  if (existing < 0) return [...messages, message].sort((left, right) => left.timestamp - right.timestamp).slice(-500);
  const next = [...messages];
  next[existing] = message;
  return next;
}

export function useChatRelay(orgId: string | undefined, roomId = "production") {
  const [messages, setMessages] = useState<MobileChatMessage[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const queueRef = useRef<string[]>([]);

  const flush = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (queueRef.current.length) socket.send(queueRef.current.shift()!);
  }, []);

  useEffect(() => {
    if (!orgId) return;
    const activeOrgId = orgId;
    let disposed = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
          if (!isRecord(payload)) return;
          if (payload.type === "hydrate" && Array.isArray(payload.messages)) {
            setMessages(payload.messages.filter(isMessage).slice(-500));
          } else if ((payload.type === "message" || payload.type === "message-edited" || payload.type === "message-deleted") && isMessage(payload.message)) {
            setMessages((current) => mergeMessage(current, payload.message as MobileChatMessage));
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

  return { messages, status, lastError, send };
}
