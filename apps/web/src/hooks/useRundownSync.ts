import { handOffRundownCommands, type RundownHandoffCommand } from "@/lib/rundown-handoff";
import { isLiveRundownTransport, RUNDOWN_TRANSPORT_MAX_AGE_MS } from "@/lib/rundown-command-protocol";
import { useState, useEffect, useRef, useCallback } from "react";
import { createBrowserId } from "@/lib/browser-id";
import { rebaseTimerToLocalClock } from "@/lib/rundown-clock";

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const toStringValue = (value: unknown, fallback = ""): string => {
  return typeof value === "string" ? value : fallback;
};

const toBoolean = (value: unknown, fallback = false): boolean => {
  return typeof value === "boolean" ? value : fallback;
};

const toNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
};

const toNullableNumber = (value: unknown, fallback: number | null): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
};

const toPlayback = (value: unknown): "stop" | "play" | "pause" => {
  return value === "play" || value === "pause" || value === "stop" ? value : "stop";
};

const toMode = (value: unknown): "count-up" | "count-down" | "clock" => {
  return value === "count-up" || value === "clock" ? value : "count-down";
};

const toItemId = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value : null;
};

const normalizeRundownItems = (value: unknown): RundownItem[] => {
  if (!Array.isArray(value)) return [];

  const items: RundownItem[] = [];

  for (const item of value) {
    if (!isObject(item)) continue;

    const rawType = toStringValue(item.type);
    const type = rawType || "segment";
    const rawStatus = toStringValue(item.status);
    const status = rawStatus || "upcoming";
    const safeId = toStringValue(item.id) || `item-${items.length}`;

    items.push({
      id: safeId,
      title: toStringValue(item.title),
      type,
      duration: Math.max(0, toNumber(item.duration, 300000)),
      notes: toStringValue(item.notes),
      assignee: toStringValue(item.assignee),
      cue: toStringValue(item.cue),
      status,
      sortOrder: toNumber(item.sortOrder, 0),
      hardStop: toBoolean(item.hardStop),
      lowerThirdId: toStringValue(item.lowerThirdId, "") || undefined,
      scheduledStart: typeof item.scheduledStart === "string" ? item.scheduledStart : null,
      expectedEnd: typeof item.expectedEnd === "string" ? item.expectedEnd : null,
      actualStart: typeof item.actualStart === "string" ? item.actualStart : null,
      actualEnd: typeof item.actualEnd === "string" ? item.actualEnd : null,
    });
  }

  return items;
};

const normalizePpPreviewSlide = (value: unknown): PPSlideState | null => {
  if (!isObject(value)) return null;

  return {
    text: toStringValue(value.text),
    notes: toStringValue(value.notes),
    presentationName: toStringValue(value.presentationName),
    isScripture: toBoolean(value.isScripture),
    updatedAt: toNumber(value.updatedAt, Date.now()),
  };
};

export const normalizeTimerState = (value: unknown, receivedAt = Date.now()): TimerState => {
  if (!isObject(value)) {
    return {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
      serverTime: Date.now(),
    };
  }

  return rebaseTimerToLocalClock({
    playback: toPlayback(value.playback),
    currentItemId: toItemId(value.currentItemId),
    // Negative elapsed is intentional: it represents time added beyond the
    // item's assigned duration and must survive relay broadcasts.
    elapsed: toNumber(value.elapsed, 0),
    startedAt: toNullableNumber(value.startedAt, null),
    pausedAt: toNullableNumber(value.pausedAt, null),
    mode: toMode(value.mode),
    serverTime: toNumber(value.serverTime, receivedAt),
  }, receivedAt);
};

interface RundownItem {
  id: string;
  title: string;
  type: string;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: string;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId?: string;
  scheduledStart?: string | null;
  expectedEnd?: string | null;
  actualStart?: string | null;
  actualEnd?: string | null;
}

interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down" | "clock";
  serverTime?: number;
}

interface PPSlideState {
  text: string;
  notes: string;
  presentationName: string;
  isScripture: boolean;
  updatedAt: number;
}

function isExpired(command: QueuedCommand): boolean {
  return isLiveRundownTransport(command.action) && Date.now() - command.queuedAt >= RUNDOWN_TRANSPORT_MAX_AGE_MS;
}

interface QueuedCommand extends RundownHandoffCommand {
  attempts: number;
}

interface UseRundownSyncReturn {
  items: RundownItem[];
  timer: TimerState;
  connected: boolean;
  /** True after we've received at least one hydrate/state message from the DO */
  hydrated: boolean;
  /**
   * The service the relay's items belong to. The room is per org, so a
   * reader that did not set this date must check it before trusting the
   * items.
   */
  stateServiceDate: string | null;
  stateShowId: string | null;
  serviceName: string | null;
  scheduledStartTime: string | null | undefined;
  scheduledCallTime: string | null | undefined;
  /** False only for a brand-new room that still needs its D1 seed. */
  stateInitialized: boolean;
  revision: number;
  /** ProPresenter preview slide data from gateway bridge (null = no active preview) */
  ppPreviewSlide: PPSlideState | null;
  /** Canonical org-wide switch that routes venue lyrics to the kiosk. */
  ppOutputEnabled: boolean;
  /** Current stage message broadcast to kiosk (empty string = none active) */
  stageMessage: string;
  lastError: string | null;
  lastErrorAt: number | null;
  retryConnection: () => void;
  /** True while local commands still need relay confirmation. */
  saving: boolean;
  unconfirmedCount: number;
  /** Synchronous pending check for navigation guards. */
  hasPendingCommands: () => boolean;
  sendCommand: (action: string, payload?: Record<string, unknown>) => void;
  /** Seed the DO with DB-loaded items (call once after connecting if DO is empty) */
  seedState: (
    items: RundownItem[],
    timer: TimerState,
    force?: boolean,
    meta?: {
      serviceName: string;
      scheduledStartTime: string | null;
      scheduledCallTime: string | null;
    },
  ) => void;
}

export function useRundownSync(
  orgId: string,
  serviceDate?: string,
  showId?: string,
  view: "rundown" | "show" = "rundown",
): UseRundownSyncReturn {
  const [items, setItems] = useState<RundownItem[]>([]);
  const [timer, setTimer] = useState<TimerState>({
    playback: "stop",
    currentItemId: null,
    elapsed: 0,
    startedAt: null,
    pausedAt: null,
    mode: "count-down",
  });
  const [connected, setConnected] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [stateServiceDate, setStateServiceDate] = useState<string | null>(null);
  const [stateShowId, setStateShowId] = useState<string | null>(null);
  const [serviceName, setServiceName] = useState<string | null>(null);
  const [scheduledStartTime, setScheduledStartTime] = useState<string | null | undefined>(undefined);
  const [scheduledCallTime, setScheduledCallTime] = useState<string | null | undefined>(undefined);
  const [stateInitialized, setStateInitialized] = useState(false);
  const [ppPreviewSlide, setPpPreviewSlide] = useState<PPSlideState | null>(null);
  const [ppOutputEnabled, setPpOutputEnabled] = useState(false);
  const [stageMessage, setStageMessage] = useState("");
  const scope = JSON.stringify([orgId, serviceDate, showId, view]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  type Failure = { scope: string; message: string; occurredAt: number };
  const [commandError, setCommandError] = useState<Failure | null>(null);
  const [transportError, setTransportFailure] = useState<Failure | null>(null);
  const [connectionError, setConnectionFailure] = useState<Failure | null>(null);
  const setLastError = useCallback((message: string | null) => setCommandError(message ? { scope: scopeRef.current, message, occurredAt: Date.now() } : null), []);
  const setTransportError = useCallback((message: string | null) => setTransportFailure(message ? { scope: scopeRef.current, message, occurredAt: Date.now() } : null), []);
  const visibleError = [transportError, commandError, connectionError].find(error => error?.scope === scope) ?? null;
  const dropConnectionRef = useRef<(socket: WebSocket, message: string) => void>(() => {});
  const reconnectRef = useRef<() => void>(() => {});
  const retryConnection = useCallback(() => reconnectRef.current(), []);
  const [unconfirmedCount, setUnconfirmedCount] = useState(0);
  const serverClockOffsetRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const socketHydratedRef = useRef(false);
  const revisionRef = useRef(0);
  const [revision, setRevision] = useState(0);
  const commandQueue = useRef<QueuedCommand[]>([]);
  const pendingCommandRef = useRef<QueuedCommand | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const unconfirmedCommandIdsRef = useRef(new Set<string>());

  const hasPendingCommands = useCallback(
    () => unconfirmedCommandIdsRef.current.size > 0,
    [],
  );

  const confirmCommand = useCallback((id: string) => {
    unconfirmedCommandIdsRef.current.delete(id);
    setUnconfirmedCount(unconfirmedCommandIdsRef.current.size);
  }, []);

  const clearPendingTimer = useCallback(() => {
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = null;
  }, []);

  const dispatchNextCommand = useCallback(() => {
    const ws = wsRef.current;
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      !socketHydratedRef.current ||
      pendingCommandRef.current
    ) return;

    let entry = commandQueue.current.shift();
    while (entry && isExpired(entry)) {
      confirmCommand(entry.id);
      setTransportError("An unconfirmed transport command expired and will not be retried. Review live state before trying again.");
      entry = commandQueue.current.shift();
    }
    if (!entry) return;
    const pending = {
      ...entry,
      expectedRevision: entry.expectedRevision ?? revisionRef.current,
    };
    pendingCommandRef.current = pending;
    clearPendingTimer();
    pendingTimerRef.current = window.setTimeout(() => {
      if (pendingCommandRef.current?.id !== pending.id) return;
      pendingCommandRef.current = null;
      pendingTimerRef.current = null;
      if (pending.attempts < 3) {
        commandQueue.current.unshift({ ...pending, attempts: pending.attempts + 1 });
        setLastError("ShowPilot is refreshing live state before retrying that rundown change.");
      } else {
        confirmCommand(pending.id);
        setLastError("That rundown change could not be confirmed. Review live state before trying again.");
      }
      dropConnectionRef.current(ws, "Rundown confirmation timed out. Reconnecting to confirm live state.");
    }, 8_000);
    try { ws.send(JSON.stringify({
      type: "command",
      id: pending.id,
      expectedRevision: pending.expectedRevision,
      action: pending.action,
      payload: pending.payload,
      ...(isLiveRundownTransport(pending.action) ? {
        expiresAt: pending.queuedAt + RUNDOWN_TRANSPORT_MAX_AGE_MS + (serverClockOffsetRef.current ?? 0),
      } : {}),
    })); } catch {
      dropConnectionRef.current(ws, "Rundown change could not be sent. Reconnecting with unconfirmed changes retained.");
    }
  }, [clearPendingTimer, confirmCommand, setLastError, setTransportError]);

  useEffect(() => {
    let disposed = false;
    let activeSocket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;
    let hydrationTimer: number | null = null;

    setConnected(false);
    setHydrated(false);
    serverClockOffsetRef.current = null;
    socketHydratedRef.current = false;
    revisionRef.current = 0;
    setRevision(0);
    commandQueue.current = [];
    pendingCommandRef.current = null;
    unconfirmedCommandIdsRef.current.clear();
    setUnconfirmedCount(0);
    clearPendingTimer();
    setLastError(null);
    setTransportError(null);
    setConnectionFailure(null);
    setPpPreviewSlide(null);
    setStateServiceDate(null);
    setStateShowId(null);
    setServiceName(null);
    setScheduledStartTime(undefined);
    setScheduledCallTime(undefined);
    setStateInitialized(false);
    setPpOutputEnabled(false);
    setStageMessage("");
    setItems([]);
    setTimer({
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
      serverTime: Date.now(),
    });

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams();
    if (serviceDate) query.set("serviceDate", serviceDate);
    if (showId) query.set("showId", showId);
    if (view === "show") query.set("view", "show");
    const suffix = query.size ? `?${query.toString()}` : "";
    const url = `${protocol}://${window.location.host}/api/rundown/${encodeURIComponent(orgId)}/ws${suffix}`;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
      reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const clearHydrationTimer = () => {
      if (hydrationTimer !== null) window.clearTimeout(hydrationTimer);
      hydrationTimer = null;
    };
    const connectionFailed = (message: string) => {
      setConnected(false);
      setConnectionFailure({ scope, message, occurredAt: Date.now() });
      scheduleReconnect();
    };
    const dropConnection = (ws: WebSocket, message: string) => {
      if (disposed || activeSocket !== ws || wsRef.current !== ws) return;
      clearHydrationTimer();
      clearPendingTimer();
      if (pendingCommandRef.current) {
        commandQueue.current.unshift(pendingCommandRef.current);
        pendingCommandRef.current = null;
      }
      activeSocket = null;
      wsRef.current = null;
      socketHydratedRef.current = false;
      ws.close();
      connectionFailed(message);
    };
    dropConnectionRef.current = dropConnection;
    reconnectRef.current = () => {
      if (disposed) return;
      if (activeSocket) dropConnection(activeSocket, "Reconnecting to confirm live rundown state.");
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      connect();
    };

    const stateMatchesTarget = (state: Record<string, unknown>) => {
      const incomingShowId = typeof state.showId === "string" ? state.showId : null;
      const incomingServiceDate = typeof state.serviceDate === "string" ? state.serviceDate : null;
      const incomingItems = Array.isArray(state.items) ? state.items : [];
      const hasRoomState = incomingItems.length > 0 || incomingShowId !== null || incomingServiceDate !== null;

      if (showId && incomingShowId !== showId) return !hasRoomState;
      if (!showId && serviceDate && incomingServiceDate && incomingServiceDate !== serviceDate) return false;
      return true;
    };

    function connect() {
      if (disposed) return;
      if (
        activeSocket?.readyState === WebSocket.OPEN ||
        activeSocket?.readyState === WebSocket.CONNECTING
      ) return;

      let ws: WebSocket;
      try { ws = new WebSocket(url); }
      catch {
        connectionFailed("The rundown connection could not open. Reconnecting.");
        return;
      }
      activeSocket = ws;
      wsRef.current = ws;
      socketHydratedRef.current = false;

      hydrationTimer = window.setTimeout(() => {
        dropConnection(ws, "Live rundown state was not confirmed within five seconds. Reconnecting.");
      }, 5_000);

      ws.onmessage = (event) => {
        if (disposed || activeSocket !== ws || wsRef.current !== ws) return;
        try {
          const msg: unknown = JSON.parse(event.data);
          if (!isObject(msg) || typeof msg.type !== "string") throw new Error("Invalid rundown message");

          if (msg.type === "command-result") {
            if (typeof msg.id !== "string" || typeof msg.accepted !== "boolean" || typeof msg.revision !== "number" || !Number.isSafeInteger(msg.revision) || msg.revision < 0) throw new Error("Invalid rundown acknowledgement");
            const pending = pendingCommandRef.current;
            if (pending && msg.id === pending.id) {
              clearPendingTimer();
              if (typeof msg.revision === "number" && Number.isFinite(msg.revision)) {
                revisionRef.current = msg.revision;
                setRevision(msg.revision);
              }
              pendingCommandRef.current = null;
              confirmCommand(pending.id);
              if (msg.accepted === false && msg.reason === "revision-conflict") {
                setLastError("Another operator changed the rundown first. Live state was refreshed; review it before trying again.");
              } else if (msg.accepted === false && msg.reason === "expired") {
                setTransportError("That transport command expired before it could apply. Live state was restored.");
              } else if (msg.accepted === false) {
                setLastError("That rundown change was rejected. Live state was restored.");
              } else {
                setLastError(null);
              }
              dispatchNextCommand();
            }
            return;
          }

          if (msg.type !== "hydrate" && msg.type !== "state") return;
          const state = msg.state;
          if (!isObject(state) || typeof state.revision !== "number" || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Invalid rundown state");
          if (!stateMatchesTarget(state)) {
            dropConnection(ws, "The rundown update did not match the selected show. Reconnecting.");
            return;
          }

          if (typeof state.revision === "number" && Number.isFinite(state.revision)) {
            revisionRef.current = Math.max(revisionRef.current, state.revision);
            setRevision(revisionRef.current);
          }
          if ("items" in state) setItems(normalizeRundownItems(state.items));
          if ("serviceDate" in state) {
            setStateServiceDate(typeof state.serviceDate === "string" ? state.serviceDate : null);
          }
          if ("showId" in state) {
            setStateShowId(typeof state.showId === "string" ? state.showId : null);
          }
          if ("serviceName" in state && typeof state.serviceName === "string") {
            setServiceName(state.serviceName);
          }
          if ("scheduledStartTime" in state) {
            setScheduledStartTime(
              state.scheduledStartTime === null || typeof state.scheduledStartTime === "string"
                ? state.scheduledStartTime
                : undefined,
            );
          }
          if ("scheduledCallTime" in state) {
            setScheduledCallTime(
              state.scheduledCallTime === null || typeof state.scheduledCallTime === "string"
                ? state.scheduledCallTime
                : undefined,
            );
          }
          if ("initialized" in state) {
            setStateInitialized(state.initialized === true);
          }
          if ("timer" in state) {
            setTimer(normalizeTimerState(state.timer));
            if (isObject(state.timer) && typeof state.timer.serverTime === "number"
              && Number.isFinite(state.timer.serverTime)) {
              serverClockOffsetRef.current = state.timer.serverTime - Date.now();
            }
          }
          if (Object.prototype.hasOwnProperty.call(state, "ppPreviewSlide")) {
            setPpPreviewSlide(normalizePpPreviewSlide(state.ppPreviewSlide));
          }
          if (Object.prototype.hasOwnProperty.call(state, "ppOutputEnabled")) {
            setPpOutputEnabled(state.ppOutputEnabled === true);
          }
          if (Object.prototype.hasOwnProperty.call(state, "stageMessage")) {
            setStageMessage(typeof state.stageMessage === "string" ? state.stageMessage : "");
          }
          clearHydrationTimer();
          reconnectAttempts = 0;
          setConnectionFailure(null);
          socketHydratedRef.current = true;
          setHydrated(true);
          setConnected(true);
          dispatchNextCommand();
        } catch {
          dropConnection(ws, "A rundown update could not be read. Reconnecting with the last known state.");
        }
      };

      ws.onclose = () => dropConnection(ws, "Rundown connection lost. Reconnecting with unconfirmed changes retained.");
      ws.onerror = () => dropConnection(ws, "Rundown connection failed. Reconnecting with unconfirmed changes retained.");
    }

    // Deferring the first connection by one task prevents React Strict Mode's
    // development remount from opening and immediately aborting a WebSocket.
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 0);

    const handOffPending = () => {
      clearPendingTimer();
      const commandsToHandOff = [
        ...(pendingCommandRef.current ? [pendingCommandRef.current] : []),
        ...commandQueue.current,
      ];
      if (commandsToHandOff.length > 0) {
        // The workspace notice outlives this route and confirms each HTTP
        // result before handing off the next command at its returned revision.
        void handOffRundownCommands({
          orgId, serviceDate, showId, view, commands: commandsToHandOff,
          revision: revisionRef.current, serverClockOffset: serverClockOffsetRef.current,
        });
      }
      commandQueue.current = [];
      pendingCommandRef.current = null;
      unconfirmedCommandIdsRef.current.clear();
      setUnconfirmedCount(0);
    };
    window.addEventListener("pagehide", handOffPending);

    return () => {
      disposed = true;
      clearHydrationTimer();
      reconnectRef.current = () => {};
      dropConnectionRef.current = () => {};
      window.removeEventListener("pagehide", handOffPending);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      handOffPending();
      socketHydratedRef.current = false;
      if (wsRef.current === activeSocket) wsRef.current = null;
      activeSocket?.close();
      activeSocket = null;
    };
  }, [clearPendingTimer, confirmCommand, dispatchNextCommand, orgId, serviceDate, showId, view, scope, setLastError, setTransportError]);

  const sendCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      if (isLiveRundownTransport(action)) setTransportError(null);
      const id = createBrowserId();
      unconfirmedCommandIdsRef.current.add(id);
      setUnconfirmedCount(unconfirmedCommandIdsRef.current.size);
      commandQueue.current.push({
        id,
        action,
        payload,
        attempts: 0,
        queuedAt: Date.now(),
      });
      dispatchNextCommand();
    },
    [dispatchNextCommand]
  );

  const seedState = useCallback(
    (
      seedItems: RundownItem[],
      seedTimer: TimerState,
      force = false,
      meta?: {
        serviceName: string;
        scheduledStartTime: string | null;
        scheduledCallTime: string | null;
      },
    ) => {
      sendCommand("seed", {
        items: seedItems,
        timer: seedTimer,
        force,
        ...meta,
      });
    },
    [sendCommand]
  );

  return {
    items,
    timer,
    connected,
    hydrated,
    stateServiceDate,
    stateShowId,
    serviceName,
    scheduledStartTime,
    scheduledCallTime,
    stateInitialized,
    revision,
    ppPreviewSlide,
    ppOutputEnabled,
    stageMessage,
    lastError: visibleError?.message ?? null,
    lastErrorAt: visibleError?.occurredAt ?? null,
    retryConnection,
    saving: unconfirmedCount > 0,
    unconfirmedCount,
    hasPendingCommands,
    sendCommand,
    seedState,
  };
}
