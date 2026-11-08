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
  queuedAt: number;
  expiresAt?: number;
  expectedRevision?: number;
}

interface RelayState {
  initialized: boolean;
  revision: number;
  items: RundownItem[];
  timer: RundownTimer;
  serviceDate: string | null;
  showId: string | null;
  serviceName: string | null;
  scheduledStartTime: string | null | undefined;
  scheduledCallTime: string | null | undefined;
  location: string | null;
  stageMessage: string;
  ppPreviewSlide: {
    text: string;
    notes: string;
    presentationName: string;
    isScripture: boolean;
    updatedAt: number;
  } | null;
}

const TRANSPORT_MAX_AGE_MS = 5_000;
function isTransport(action: string) { return action.startsWith("timer-") && action !== "timer-mode"; }
function expired(command: QueuedCommand) { return isTransport(command.action) && Date.now() - command.queuedAt >= TRANSPORT_MAX_AGE_MS; }

const EMPTY_TIMER: RundownTimer = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
};

function emptyRelayState(): RelayState {
  return {
    initialized: false,
    revision: 0,
    items: [],
    timer: EMPTY_TIMER,
    serviceDate: null,
    showId: null,
    serviceName: null,
    scheduledStartTime: undefined,
    scheduledCallTime: undefined,
    location: null,
    stageMessage: "",
    ppPreviewSlide: null,
  };
}

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
  const [state, setState] = useState<RelayState>(emptyRelayState);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [hydrated, setHydrated] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [unconfirmedCount, setUnconfirmedCount] = useState(0);
  const serverClockOffsetRef = useRef<number | null>(null);
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

  const updateCount = useCallback(() => setUnconfirmedCount(queueRef.current.length + (pendingRef.current ? 1 : 0)), []);

  const dispatchNext = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !hydratedRef.current || pendingRef.current) return;
    let command = queueRef.current.shift();
    while (command && expired(command)) {
      setCommandError("An unconfirmed transport command expired and will not be retried. Review live state before trying again.");
      command = queueRef.current.shift();
    }
    updateCount();
    if (!command) return;
    const pending = {
      ...command,
      expectedRevision: command.expectedRevision ?? revisionRef.current,
    };
    pendingRef.current = pending;
    updateCount();
    clearPendingTimer();
    pendingTimerRef.current = setTimeout(() => {
      if (pendingRef.current?.id !== pending.id) return;
      pendingRef.current = null;
      pendingTimerRef.current = null;
      if (expired(pending)) {
        setCommandError("An unconfirmed transport command expired and will not be retried. It may have completed; review live state before trying again.");
      } else if (pending.attempts < 3) {
        queueRef.current.unshift({ ...pending, attempts: pending.attempts + 1 });
        setConnectionError("ShowPilot is refreshing live state before retrying that control change.");
      } else {
        setCommandError("That control change could not be confirmed. Check the live state before trying again.");
      }
      updateCount();
      if (socketRef.current === socket) {
        hydratedRef.current = false;
        setHydrated(false);
        setStatus("reconnecting");
        socket.close();
      }
    }, 8_000);
    try { socket.send(JSON.stringify({
      type: "command",
      id: pending.id,
      expectedRevision: pending.expectedRevision,
      action: pending.action,
      payload: pending.payload,
      ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
    })); } catch {
      setConnectionError("The control change could not be sent. Reconnecting with its original request retained.");
      hydratedRef.current = false;
      setHydrated(false);
      setStatus("reconnecting");
      socket.close();
    }
  }, [clearPendingTimer, updateCount]);

  useEffect(() => {
    let disposed = false;
    let connecting = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    hydratedRef.current = false;
    revisionRef.current = 0;
    serverClockOffsetRef.current = null;
    queueRef.current = [];
    pendingRef.current = null;
    clearPendingTimer();
    setState(emptyRelayState());
    setHydrated(false);
    setConnectionError(null);
    setCommandError(null);
    updateCount();

    if (!orgId || !serviceDate || !showId) {
      setStatus("offline");
      setHydrated(false);
      return () => {
        disposed = true;
      };
    }

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
        void connect();
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
        hydratedRef.current = false;
        setHydrated(false);
        setConnectionError("Live state belongs to another show. Reconnect before sending controls.");
        return;
      }

      if (isRecord(value.timer) && typeof value.timer.serverTime === "number" && Number.isFinite(value.timer.serverTime)) {
        serverClockOffsetRef.current = value.timer.serverTime - Date.now();
      }
      if (typeof value.revision === "number" && Number.isFinite(value.revision)) {
        revisionRef.current = Math.max(revisionRef.current, value.revision);
      }
      setState((current) => ({
        initialized: "initialized" in value ? value.initialized === true : current.initialized,
        revision: typeof value.revision === "number" && Number.isFinite(value.revision)
          ? value.revision
          : current.revision,
        items: "items" in value ? normalizeRelayItems(value.items) : current.items,
        timer: "timer" in value ? normalizeRelayTimer(value.timer) : current.timer,
        serviceDate: "serviceDate" in value ? incomingServiceDate : current.serviceDate,
        showId: "showId" in value ? incomingShowId : current.showId,
        serviceName: "serviceName" in value && typeof value.serviceName === "string"
          ? value.serviceName
          : current.serviceName,
        scheduledStartTime: "scheduledStartTime" in value
          && (value.scheduledStartTime === null || typeof value.scheduledStartTime === "string")
          ? value.scheduledStartTime
          : current.scheduledStartTime,
        scheduledCallTime: "scheduledCallTime" in value
          && (value.scheduledCallTime === null || typeof value.scheduledCallTime === "string")
          ? value.scheduledCallTime
          : current.scheduledCallTime,
        location: "location" in value && typeof value.location === "string"
          ? value.location
          : current.location,
        stageMessage: "stageMessage" in value && typeof value.stageMessage === "string"
          ? value.stageMessage
          : current.stageMessage,
        ppPreviewSlide: "ppPreviewSlide" in value
          ? normalizePPSlide(value.ppPreviewSlide)
          : current.ppPreviewSlide,
      }));
      hydratedRef.current = true;
      setHydrated(true);
      setConnectionError(null);
      dispatchNext();
    }

    async function connect() {
      if (disposed || connecting || AppState.currentState !== "active") return;
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) return;

      setStatus(attempts ? "reconnecting" : "connecting");
      connecting = true;
      let socket: WebSocket;
      try {
        socket = await createAuthenticatedWebSocket(relayUrl(orgId, serviceDate, showId), orgId);
      } catch (error) {
        connecting = false;
        if (!disposed) {
          setConnectionError(error instanceof Error ? error.message : "Live authentication failed.");
          scheduleReconnect();
        }
        return;
      }
      connecting = false;
      if (disposed || AppState.currentState !== "active") {
        socket.close();
        return;
      }
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
          if (typeof message.accepted !== "boolean") {
            setConnectionError("The control acknowledgement was unreadable. Waiting to confirm the original request.");
            return;
          }
          clearPendingTimer();
          if (typeof message.revision === "number" && Number.isFinite(message.revision)) {
            revisionRef.current = message.revision;
          }
          pendingRef.current = null;
          if (message.accepted === false && message.reason === "revision-conflict") {
            setCommandError("Another operator changed the rundown first. Live state was refreshed; review it before trying again.");
          } else if (message.accepted === false) {
            setCommandError(message.reason === "expired"
              ? "That transport command expired and was not applied. Review live state before trying again."
              : "That control change was not accepted. Review the current live state before trying again.");
          }
          updateCount();
          dispatchNext();
        } catch {
          setConnectionError("ShowPilot received an unreadable live update.");
        }
      };

      socket.onerror = () => {
        if (disposed || socketRef.current !== socket) return;
        hydratedRef.current = false;
        setHydrated(false);
        setStatus("reconnecting");
        setConnectionError("The live connection was interrupted. Reconnecting…");
        socket.close();
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
        updateCount();
        if (!disposed) {
          setHydrated(false);
          scheduleReconnect();
        }
      };
    }

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (disposed) return;
      if (nextState === "active") {
        void connect();
      } else {
        setStatus("offline");
        socketRef.current?.close();
      }
    });

    void connect();
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
  }, [clearPendingTimer, dispatchNext, orgId, serviceDate, showId, updateCount]);

  const sendCommand = useCallback((action: string, payload?: Record<string, unknown>) => {
    const transport = isTransport(action);
    const clockOffset = serverClockOffsetRef.current;
    const ready = socketRef.current?.readyState === WebSocket.OPEN && hydratedRef.current;
    if (transport && (!ready || clockOffset === null)) {
      setCommandError("Transport command not sent. Reconnect and review live state before trying again.");
      return "blocked" as const;
    }
    const queuedAt = Date.now();
    const waiting = !ready || Boolean(pendingRef.current) || queueRef.current.length > 0;
    queueRef.current.push({ id: commandId(), action, payload, attempts: 0, queuedAt,
      ...(transport && clockOffset !== null ? { expectedRevision: revisionRef.current, expiresAt: queuedAt + TRANSPORT_MAX_AGE_MS + clockOffset } : {}),
    });
    updateCount();
    dispatchNext();
    return waiting ? "queued" as const : "sent" as const;
  }, [dispatchNext, updateCount]);

  const seedState = useCallback((
    items: RundownItem[],
    timer: RundownTimer,
    meta?: {
      serviceName: string;
      scheduledStartTime: string | null;
      scheduledCallTime: string | null;
      location: string;
    },
  ) => {
    sendCommand("seed", { items, timer, force: false, ...meta });
  }, [sendCommand]);

  return { ...state, status, hydrated, lastError: commandError ?? connectionError, commandError, unconfirmedCount, dismissCommandError: () => setCommandError(null), sendCommand, seedState };
}

function normalizePPSlide(value: unknown): RelayState["ppPreviewSlide"] {
  if (!isRecord(value)) return null;
  if (
    typeof value.text !== "string"
    || typeof value.notes !== "string"
    || typeof value.presentationName !== "string"
    || typeof value.isScripture !== "boolean"
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)
  ) return null;
  return {
    text: value.text,
    notes: value.notes,
    presentationName: value.presentationName,
    isScripture: value.isScripture,
    updatedAt: value.updatedAt,
  };
}
