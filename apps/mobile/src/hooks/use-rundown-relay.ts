import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { createAuthenticatedWebSocket } from "@/lib/auth-transport";
import { SHOWPILOT_URL } from "@/lib/env";
import type { RundownItem, RundownTimer } from "@/lib/mobile-api";
import { normalizeRelayItems, normalizeRelayTimer } from "@/lib/rundown-state";

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";

interface QueuedCommand {
  id: string;
  action: string;
  payload?: Record<string, unknown>;
  attempts: number;
}

interface RelayState {
  items: RundownItem[];
  timer: RundownTimer;
  serviceDate: string | null;
  showId: string | null;
}

const EMPTY_TIMER: RundownTimer = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function relayUrl(orgId: string, serviceDate: string, showId: string) {
  const url = new URL(SHOWPILOT_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/rundown/${encodeURIComponent(orgId)}/ws`;
  url.search = new URLSearchParams({ serviceDate, showId }).toString();
  return url.toString();
}

export function useRundownRelay(orgId: string, serviceDate: string, showId: string) {
  const [state, setState] = useState<RelayState>({
    items: [],
    timer: EMPTY_TIMER,
    serviceDate: null,
    showId: null,
  });
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [hydrated, setHydrated] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const hydratedRef = useRef(false);
  const revisionRef = useRef(0);
  const queueRef = useRef<QueuedCommand[]>([]);
  const pendingRef = useRef<QueuedCommand | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = null;
  }, []);

  const dispatchNext = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !hydratedRef.current || pendingRef.current) return;
    const command = queueRef.current.shift();
    if (!command) return;
    pendingRef.current = command;
    clearPendingTimer();
    pendingTimerRef.current = setTimeout(() => {
      if (pendingRef.current?.id !== command.id) return;
      pendingRef.current = null;
      pendingTimerRef.current = null;
      if (command.attempts < 3) {
        queueRef.current.unshift({ ...command, attempts: command.attempts + 1 });
        setLastError("ShowPilot is refreshing live state before retrying that control change.");
      } else {
        setLastError("That control change could not be confirmed. Check the live state before trying again.");
      }
      if (socketRef.current === socket) socket.close();
    }, 8_000);
    socket.send(JSON.stringify({
      type: "command",
      id: command.id,
      expectedRevision: revisionRef.current,
      action: command.action,
      payload: command.payload,
    }));
  }, [clearPendingTimer]);

  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    hydratedRef.current = false;
    revisionRef.current = 0;
    queueRef.current = [];
    pendingRef.current = null;
    clearPendingTimer();

    function clearKeepalive() {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }

    function scheduleReconnect() {
      if (disposed || reconnectTimer || AppState.currentState !== "active") return;
      setStatus("reconnecting");
      const delay = Math.min(1_000 * 2 ** attempts, 30_000);
      attempts = Math.min(attempts + 1, 6);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function applyState(value: unknown) {
      if (!isRecord(value)) return;
      const incomingShowId = typeof value.showId === "string" ? value.showId : null;
      const incomingServiceDate = typeof value.serviceDate === "string" ? value.serviceDate : null;
      const incomingItems = Array.isArray(value.items) ? value.items : [];
      const hasRoomState = incomingItems.length > 0 || incomingShowId !== null || incomingServiceDate !== null;
      if (
        (incomingShowId !== showId && hasRoomState) ||
        (!incomingShowId && incomingServiceDate && incomingServiceDate !== serviceDate)
      ) {
        setState((current) => ({ ...current, serviceDate: incomingServiceDate, showId: incomingShowId }));
        hydratedRef.current = true;
        setHydrated(true);
        dispatchNext();
        return;
      }

      if (typeof value.revision === "number" && Number.isFinite(value.revision)) {
        revisionRef.current = Math.max(revisionRef.current, value.revision);
      }
      setState((current) => ({
        items: "items" in value ? normalizeRelayItems(value.items) : current.items,
        timer: "timer" in value ? normalizeRelayTimer(value.timer) : current.timer,
        serviceDate: "serviceDate" in value ? incomingServiceDate : current.serviceDate,
        showId: "showId" in value ? incomingShowId : current.showId,
      }));
      hydratedRef.current = true;
      setHydrated(true);
      setLastError(null);
      dispatchNext();
    }

    function connect() {
      if (disposed || AppState.currentState !== "active") return;
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) return;

      setStatus(attempts ? "reconnecting" : "connecting");
      const socket = createAuthenticatedWebSocket(relayUrl(orgId, serviceDate, showId));
      socketRef.current = socket;
      hydratedRef.current = false;

      socket.onopen = () => {
        if (disposed || socketRef.current !== socket) return;
        attempts = 0;
        setStatus("connected");
        clearKeepalive();
        keepaliveTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, 20_000);
      };

      socket.onmessage = (event) => {
        if (disposed || socketRef.current !== socket || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as unknown;
          if (!isRecord(message)) return;
          if (message.type === "hydrate" || message.type === "state") {
            applyState(message.state);
            return;
          }
          if (message.type !== "command-result") return;
          const pending = pendingRef.current;
          if (!pending || message.id !== pending.id) return;
          clearPendingTimer();
          if (typeof message.revision === "number" && Number.isFinite(message.revision)) {
            revisionRef.current = message.revision;
          }
          pendingRef.current = null;
          if (message.accepted === false && message.reason === "revision-conflict" && pending.attempts < 3) {
            queueRef.current.unshift({ ...pending, attempts: pending.attempts + 1 });
          } else if (message.accepted === false) {
            setLastError("That control change was not accepted. The live state has been refreshed.");
          }
          dispatchNext();
        } catch {
          setLastError("ShowPilot received an unreadable live update.");
        }
      };

      socket.onerror = () => {
        if (!disposed) setLastError("The live connection was interrupted. Reconnecting…");
      };

      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        clearKeepalive();
        clearPendingTimer();
        if (pendingRef.current) {
          queueRef.current.unshift(pendingRef.current);
          pendingRef.current = null;
        }
        socketRef.current = null;
        hydratedRef.current = false;
        if (!disposed) scheduleReconnect();
      };
    }

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (disposed) return;
      if (nextState === "active") {
        connect();
      } else {
        setStatus("offline");
        socketRef.current?.close();
      }
    });

    connect();
    return () => {
      disposed = true;
      appStateSubscription.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearKeepalive();
      clearPendingTimer();
      queueRef.current = [];
      pendingRef.current = null;
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [clearPendingTimer, dispatchNext, orgId, serviceDate, showId]);

  const sendCommand = useCallback((action: string, payload?: Record<string, unknown>) => {
    queueRef.current.push({ id: commandId(), action, payload, attempts: 0 });
    dispatchNext();
  }, [dispatchNext]);

  const seedState = useCallback((items: RundownItem[], timer: RundownTimer) => {
    sendCommand("seed", { items, timer, force: false });
  }, [sendCommand]);

  return { ...state, status, hydrated, lastError, sendCommand, seedState };
}
