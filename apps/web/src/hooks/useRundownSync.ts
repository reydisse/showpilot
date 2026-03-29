import { useState, useEffect, useRef, useCallback } from "react";

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
}

interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down";
  serverTime?: number;
}

interface RundownState {
  items: RundownItem[];
  timer: TimerState;
}

interface UseRundownSyncReturn {
  /** Live items from DO — updates in real time */
  items: RundownItem[];
  /** Live timer from DO */
  timer: TimerState;
  /** WebSocket connected to DO */
  connected: boolean;
  /** Send a command to the DO (all clients will see the update) */
  sendCommand: (action: string, payload?: Record<string, unknown>) => void;
}

/**
 * Hook that connects to the RundownRelay Durable Object via WebSocket.
 * Keeps items and timer in sync across all connected devices.
 */
export function useRundownSync(orgId: string): UseRundownSyncReturn {
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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/api/rundown/${orgId}/ws`;

    const ws = new WebSocket(url);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "hydrate" || msg.type === "state") {
          setItems(msg.state.items);
          setTimer(msg.state.timer);
        }
      } catch {
        // Ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Auto-reconnect
      reconnectTimer.current = setTimeout(() => connect(), 3000);
    };

    ws.onerror = () => {};

    wsRef.current = ws;
  }, [orgId]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const sendCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: "command", action, payload })
        );
      }
    },
    []
  );

  return { items, timer, connected, sendCommand };
}
