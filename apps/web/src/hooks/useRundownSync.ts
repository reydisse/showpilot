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
  sendCommand: (action: string, payload?: Record<string, unknown>) => void;
  /** Seed the DO with DB-loaded items (call once after connecting if DO is empty) */
  seedState: (items: RundownItem[], timer: TimerState) => void;
}

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
  const [hydrated, setHydrated] = useState(false);
  const [ppPreviewSlide, setPpPreviewSlide] = useState<PPSlideState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/api/rundown/${orgId}/ws`;

    const ws = new WebSocket(url);
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    ws.onopen = () => {
      setConnected(true);
      // Keepalive to prevent DO hibernation
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 20000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "hydrate" || msg.type === "state") {
          // Always accept DO state — it is the source of truth once connected
          if (msg.state.items) {
            setItems(msg.state.items);
          }
          if (msg.state.timer) {
            setTimer(msg.state.timer);
          }
          // PP preview slide data from gateway bridge
          if (msg.state.ppPreviewSlide !== undefined) {
            setPpPreviewSlide(msg.state.ppPreviewSlide);
          }
          setHydrated(true);
        }
      } catch {
        // Ignore
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setHydrated(false); // Reset so we wait for fresh hydrate on reconnect
      wsRef.current = null;
      if (pingTimer) clearInterval(pingTimer);
      reconnectTimer.current = setTimeout(() => connect(), 1000);
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

  const seedState = useCallback(
    (seedItems: RundownItem[], seedTimer: TimerState) => {
      sendCommand("seed", {
        items: seedItems,
        timer: seedTimer,
      });
    },
    [sendCommand]
  );

  return { items, timer, connected, hydrated, ppPreviewSlide, sendCommand, seedState };
}
