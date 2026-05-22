import { useState, useEffect, useRef, useCallback } from "react";

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

const normalizeTimerState = (value: unknown): TimerState => {
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

  return {
    playback: toPlayback(value.playback),
    currentItemId: toItemId(value.currentItemId),
    elapsed: Math.max(0, toNumber(value.elapsed, 0)),
    startedAt: toNullableNumber(value.startedAt, null),
    pausedAt: toNullableNumber(value.pausedAt, null),
    mode: toMode(value.mode),
    serverTime: toNumber(value.serverTime, Date.now()),
  };
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

interface UseRundownSyncReturn {
  items: RundownItem[];
  timer: TimerState;
  connected: boolean;
  /** True after we've received at least one hydrate/state message from the DO */
  hydrated: boolean;
  /** ProPresenter preview slide data from gateway bridge (null = no active preview) */
  ppPreviewSlide: PPSlideState | null;
  /** Current stage message broadcast to kiosk (empty string = none active) */
  stageMessage: string;
  sendCommand: (action: string, payload?: Record<string, unknown>) => void;
  /** Seed the DO with DB-loaded items (call once after connecting if DO is empty) */
  seedState: (items: RundownItem[], timer: TimerState) => void;
}

export function useRundownSync(orgId: string, serviceDate?: string): UseRundownSyncReturn {
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
  const [ppPreviewSlide, setPpPreviewSlide] = useState<PPSlideState | null>(null);
  const [stageMessage, setStageMessage] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectAttempts = useRef(0);
  const intentionalClose = useRef(false);
  const commandQueue = useRef<Array<{ action: string; payload?: Record<string, unknown> }>>([]);

  const clearPingTimer = () => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  };

  const scheduleReconnect = useCallback(() => {
    if (intentionalClose.current) return;
    if (reconnectTimer.current) return;

    const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000);
    reconnectAttempts.current = Math.min(reconnectAttempts.current + 1, 6);

    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null;
      connect();
    }, delay);
  }, []);

  const flushCommandQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    while (commandQueue.current.length > 0) {
      const entry = commandQueue.current.shift();
      if (!entry) continue;
      ws.send(JSON.stringify({ type: "command", action: entry.action, payload: entry.payload }));
    }
  }, []);

  const connect = useCallback(() => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const qs = serviceDate ? `?serviceDate=${encodeURIComponent(serviceDate)}` : "";
    const url = `${protocol}://${window.location.host}/api/rundown/${orgId}/ws${qs}`;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      intentionalClose.current = false;
      reconnectAttempts.current = 0;
      clearPingTimer();
      setConnected(true);
      // Keepalive to prevent DO hibernation
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 20000);
      flushCommandQueue();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (!isObject(msg)) return;
        if (msg.type !== "hydrate" && msg.type !== "state") return;

        const state = msg.state;
        if (!isObject(state)) return;

        // Always accept DO state — it is the source of truth once connected
        if ("items" in state) {
          setItems(normalizeRundownItems(state.items));
        }
        if ("timer" in state) {
          setTimer(normalizeTimerState(state.timer));
        }
        if (Object.prototype.hasOwnProperty.call(state, "ppPreviewSlide")) {
          setPpPreviewSlide(normalizePpPreviewSlide(state.ppPreviewSlide));
        }
        if (Object.prototype.hasOwnProperty.call(state, "stageMessage")) {
          setStageMessage(typeof state.stageMessage === "string" ? state.stageMessage : "");
        }
        setHydrated(true);
      } catch {
        // Ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      clearPingTimer();
      scheduleReconnect();
    };

    ws.onerror = () => {};

    wsRef.current = ws;
    reconnectTimer.current && clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
  }, [orgId, serviceDate, flushCommandQueue, scheduleReconnect]);

  useEffect(() => {
    intentionalClose.current = false;
    connect();

    return () => {
      intentionalClose.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
      clearPingTimer();
      commandQueue.current = [];
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const sendCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "command", action, payload }));
        return;
      }

      commandQueue.current.push({ action, payload });
    },
    []
  );

  const seedState = useCallback(
    (seedItems: RundownItem[], seedTimer: TimerState) => {
      sendCommand("seed", {
        items: seedItems,
        timer: seedTimer,
      });
    },
    [sendCommand]
  );

  return { items, timer, connected, hydrated, ppPreviewSlide, stageMessage, sendCommand, seedState };
}
