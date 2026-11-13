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
const CONNECTION_TIMEOUT_MS = 12_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 8_000;
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
  const restartConnectionRef = useRef<(message?: string) => void>(() => {});
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
        restartConnectionRef.current("Live state is being refreshed after an unconfirmed command.");
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
      restartConnectionRef.current("The control change could not be sent. Reconnecting with its original request retained.");
    }
  }, [clearPendingTimer, updateCount]);

  useEffect(() => {
    let disposed = false;
    let connecting = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    let authentication: AbortController | null = null;
    let generation = 0;
    let heartbeat: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;
    let hydratedRevision = 0;

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
      if (heartbeat) clearTimeout(heartbeat.timer);
      heartbeat = null;
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

    function clearHandshake() {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }

    // Detach before close: native platforms may delay or omit the close event.
    // Late authentication and callbacks from this generation no longer own state.
    function retireConnection(message?: string, reconnect = true) {
      generation += 1;
      authentication?.abort();
      authentication = null;
      connecting = false;
      clearHandshake();
      clearKeepalive();
      clearPendingTimer();
      if (pendingRef.current) {
        queueRef.current.unshift(pendingRef.current);
        pendingRef.current = null;
      }
      const socket = socketRef.current;
      socketRef.current = null;
      hydratedRef.current = false;
      socket?.close();
      if (disposed) return;
      setHydrated(false);
      updateCount();
      if (message) setConnectionError(message);
      if (reconnect) scheduleReconnect();
      else setStatus("offline");
    }

    restartConnectionRef.current = (message) => {
      retireConnection(message, Boolean(message));
      if (!message) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attempts = 0;
        void connect();
      }
    };

    function applyState(value: unknown) {
      if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.timer)
        || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) {
        retireConnection("ShowPilot received an unreadable live update. Reconnecting for current state.");
        return;
      }
      const incomingShowId = typeof value.showId === "string" ? value.showId : null;
      const incomingServiceDate = typeof value.serviceDate === "string" ? value.serviceDate : null;
      const incomingItems = Array.isArray(value.items) ? value.items : [];
      const hasRoomState = incomingItems.length > 0 || incomingShowId !== null || incomingServiceDate !== null;
      if (
        (incomingShowId !== showId && hasRoomState) ||
        (incomingServiceDate !== serviceDate && hasRoomState)
      ) {
        retireConnection("Live state belongs to another show. Reconnecting before sending controls.");
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
      hydratedRevision = value.revision;
      clearHandshake();
      attempts = 0;
      hydratedRef.current = true;
      setHydrated(true);
      setStatus("connected");
      setConnectionError(null);
      dispatchNext();
    }

    async function connect() {
      if (disposed || connecting || AppState.currentState !== "active") return;
      const existing = socketRef.current;
      if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) return;

      setStatus(attempts ? "reconnecting" : "connecting");
      connecting = true;
      const attemptGeneration = ++generation;
      const controller = new AbortController();
      authentication = controller;
      clearHandshake();
      handshakeTimer = setTimeout(() => {
        if (disposed || generation !== attemptGeneration) return;
        retireConnection("The live connection timed out before current state arrived. Retrying…");
      }, CONNECTION_TIMEOUT_MS);
      let socket: WebSocket;
      try {
        socket = await createAuthenticatedWebSocket(relayUrl(orgId, serviceDate, showId), orgId, controller.signal);
      } catch (error) {
        if (!disposed && generation === attemptGeneration) {
          retireConnection(error instanceof Error ? error.message : "Live authentication failed.");
        }
        return;
      }
      if (disposed || generation !== attemptGeneration || AppState.currentState !== "active") {
        socket.close();
        return;
      }
      connecting = false;
      socketRef.current = socket;
      hydratedRef.current = false;

      socket.onopen = () => {
        if (disposed || socketRef.current !== socket) return;
        clearKeepalive();
        keepaliveTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN || !hydratedRef.current || heartbeat) return;
          const id = commandId();
          heartbeat = { id, timer: setTimeout(() => {
            if (socketRef.current !== socket || heartbeat?.id !== id) return;
            retireConnection("The live connection stopped responding. Reconnecting with the last known state.");
          }, HEARTBEAT_TIMEOUT_MS) };
          try { socket.send(JSON.stringify({ type: "ping", id })); }
          catch { retireConnection("The live connection was interrupted. Reconnecting…"); }
        }, HEARTBEAT_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (disposed || socketRef.current !== socket || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as unknown;
          if (!isRecord(message)) return;
          if (message.type === "pong") {
            if (!heartbeat || message.id !== heartbeat.id) return;
            if (message.showId !== showId || message.serviceDate !== serviceDate
              || typeof message.revision !== "number" || !Number.isSafeInteger(message.revision) || message.revision < 0) {
              retireConnection("The live connection returned an invalid heartbeat. Reconnecting for current state.");
              return;
            }
            if (message.revision > hydratedRevision) {
              retireConnection("A live update was missed. Reconnecting for current state.");
              return;
            }
            clearTimeout(heartbeat.timer);
            heartbeat = null;
            return;
          }
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
          retireConnection("ShowPilot received an unreadable live update. Reconnecting for current state.");
        }
      };

      socket.onerror = () => {
        if (disposed || socketRef.current !== socket) return;
        retireConnection("The live connection was interrupted. Reconnecting…");
      };

      socket.onclose = () => {
        if (disposed || socketRef.current !== socket) return;
        retireConnection("The live connection closed. Reconnecting with the last known state.");
      };
    }

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (disposed) return;
      if (nextState === "active") {
        void connect();
      } else {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        retireConnection(undefined, false);
      }
    });

    void connect();
    return () => {
      disposed = true;
      appStateSubscription.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      retireConnection(undefined, false);
      restartConnectionRef.current = () => {};
      queueRef.current = [];
      pendingRef.current = null;
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

  return { ...state, status, hydrated, lastError: commandError ?? connectionError, commandError, unconfirmedCount, dismissCommandError: () => setCommandError(null), retryConnection: () => restartConnectionRef.current(), sendCommand, seedState };
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
