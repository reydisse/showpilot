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

interface QueuedCommand {
  id: string;
  action: string;
  payload?: Record<string, unknown>;
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
  /** False only for a brand-new room that still needs its D1 seed. */
  stateInitialized: boolean;
  /** ProPresenter preview slide data from gateway bridge (null = no active preview) */
  ppPreviewSlide: PPSlideState | null;
  /** Current stage message broadcast to kiosk (empty string = none active) */
  stageMessage: string;
  sendCommand: (action: string, payload?: Record<string, unknown>) => void;
  /** Seed the DO with DB-loaded items (call once after connecting if DO is empty) */
  seedState: (items: RundownItem[], timer: TimerState, force?: boolean) => void;
}

export function useRundownSync(
  orgId: string,
  serviceDate?: string,
  showId?: string,
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
  const [stateInitialized, setStateInitialized] = useState(false);
  const [ppPreviewSlide, setPpPreviewSlide] = useState<PPSlideState | null>(null);
  const [stageMessage, setStageMessage] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const socketHydratedRef = useRef(false);
  const revisionRef = useRef(0);
  const commandQueue = useRef<QueuedCommand[]>([]);
  const pendingCommandRef = useRef<QueuedCommand | null>(null);

  const dispatchNextCommand = useCallback(() => {
    const ws = wsRef.current;
    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      !socketHydratedRef.current ||
      pendingCommandRef.current
    ) return;

    const entry = commandQueue.current.shift();
    if (!entry) return;
    pendingCommandRef.current = entry;
    ws.send(JSON.stringify({
      type: "command",
      id: entry.id,
      expectedRevision: revisionRef.current,
      action: entry.action,
      payload: entry.payload,
    }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let activeSocket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;

    setHydrated(false);
    socketHydratedRef.current = false;
    revisionRef.current = 0;
    commandQueue.current = [];
    pendingCommandRef.current = null;
    setStateServiceDate(null);
    setStateShowId(null);
    setStateInitialized(false);
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
    const suffix = query.size ? `?${query.toString()}` : "";
    const url = `${protocol}://${window.location.host}/api/rundown/${orgId}/ws${suffix}`;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
      reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
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

      const ws = new WebSocket(url);
      activeSocket = ws;
      wsRef.current = ws;
      socketHydratedRef.current = false;

      ws.onopen = () => {
        if (disposed || activeSocket !== ws) return;
        reconnectAttempts = 0;
        setConnected(true);
      };

      ws.onmessage = (event) => {
        if (disposed || activeSocket !== ws || wsRef.current !== ws) return;
        try {
          const msg = JSON.parse(event.data);
          if (!isObject(msg)) return;

          if (msg.type === "command-result") {
            const pending = pendingCommandRef.current;
            if (pending && msg.id === pending.id) {
              if (typeof msg.revision === "number" && Number.isFinite(msg.revision)) {
                revisionRef.current = msg.revision;
              }
              pendingCommandRef.current = null;
              dispatchNextCommand();
            }
            return;
          }

          if (msg.type !== "hydrate" && msg.type !== "state") return;
          const state = msg.state;
          if (!isObject(state) || !stateMatchesTarget(state)) return;

          if (typeof state.revision === "number" && Number.isFinite(state.revision)) {
            revisionRef.current = Math.max(revisionRef.current, state.revision);
          }
          if ("items" in state) setItems(normalizeRundownItems(state.items));
          if ("serviceDate" in state) {
            setStateServiceDate(typeof state.serviceDate === "string" ? state.serviceDate : null);
          }
          if ("showId" in state) {
            setStateShowId(typeof state.showId === "string" ? state.showId : null);
          }
          if ("initialized" in state) {
            setStateInitialized(state.initialized === true);
          }
          if ("timer" in state) setTimer(normalizeTimerState(state.timer));
          if (Object.prototype.hasOwnProperty.call(state, "ppPreviewSlide")) {
            setPpPreviewSlide(normalizePpPreviewSlide(state.ppPreviewSlide));
          }
          if (Object.prototype.hasOwnProperty.call(state, "stageMessage")) {
            setStageMessage(typeof state.stageMessage === "string" ? state.stageMessage : "");
          }
          socketHydratedRef.current = true;
          setHydrated(true);
          dispatchNextCommand();
        } catch {
          // Ignore malformed relay frames without disturbing the live state.
        }
      };

      ws.onclose = () => {
        if (disposed || activeSocket !== ws) return;
        if (pendingCommandRef.current) {
          commandQueue.current.unshift(pendingCommandRef.current);
          pendingCommandRef.current = null;
        }
        activeSocket = null;
        if (wsRef.current === ws) wsRef.current = null;
        socketHydratedRef.current = false;
        setConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {};
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      commandQueue.current = [];
      pendingCommandRef.current = null;
      socketHydratedRef.current = false;
      if (wsRef.current === activeSocket) wsRef.current = null;
      activeSocket?.close();
      activeSocket = null;
    };
  }, [dispatchNextCommand, orgId, serviceDate, showId]);

  const sendCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      commandQueue.current.push({
        id: createBrowserId(),
        action,
        payload,
      });
      dispatchNextCommand();
    },
    [dispatchNextCommand]
  );

  const seedState = useCallback(
    (seedItems: RundownItem[], seedTimer: TimerState, force = false) => {
      sendCommand("seed", {
        items: seedItems,
        timer: seedTimer,
        force,
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
    stateInitialized,
    ppPreviewSlide,
    stageMessage,
    sendCommand,
    seedState,
  };
}
