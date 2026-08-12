import { useState, useEffect, useRef, useCallback } from "react";
import type {
  TimecodeState,
  TimecodeFormat,
  TimecodeValue,
  AutomationEvent,
  TimecodeWsMessage,
} from "@/types/timecode";
import { timecodeToFrames, timecodeToString } from "@/lib/timecode";
import { InternalTimecodeSource } from "@/lib/timecode-sources/internal-source";
import { MtcSource } from "@/lib/timecode-sources/mtc-source";

interface UseTimecodeOptions {
  orgId: string;
  enabled: boolean;
  /** Base URL for the timecode relay WebSocket */
  relayBaseUrl?: string;
}

interface UseTimecodeReturn {
  state: TimecodeState | null;
  display: string;
  connected: boolean;
  events: AutomationEvent[];
  isMaster: boolean;

  // Master controls
  startFreerun: (offsetMs?: number) => void;
  stopGenerator: () => void;
  startMtc: (inputId: string) => Promise<void>;
  stopMtc: () => void;
  setTimecode: (tc: TimecodeValue) => void;
  setFormat: (format: TimecodeFormat) => void;

  // Event management
  addEvent: (event: Omit<AutomationEvent, "id" | "fired" | "triggerFrame">) => void;
  updateEvent: (id: string, updates: Partial<AutomationEvent>) => void;
  removeEvent: (id: string) => void;
  resetEvents: () => void;

  // MTC support
  mtcSupported: boolean;
}

const FEED_INTERVAL_MS = 100; // 10Hz feed to relay

export function useTimecode({
  orgId,
  enabled,
  relayBaseUrl,
}: UseTimecodeOptions): UseTimecodeReturn {
  const [state, setState] = useState<TimecodeState | null>(null);
  const [events, setEvents] = useState<AutomationEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [isMaster, setIsMaster] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const internalSourceRef = useRef<InternalTimecodeSource | null>(null);
  const mtcSourceRef = useRef<MtcSource | null>(null);
  const feedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestTcRef = useRef<{
    tc: TimecodeValue;
    totalFrames: number;
    display: string;
    format: TimecodeFormat;
  } | null>(null);
  const formatRef = useRef<TimecodeFormat>({ frameRate: 30, dropFrame: "ndf" });

  useEffect(() => {
    if (state?.format) formatRef.current = state.format;
  }, [state?.format]);

  // ─── WebSocket connection to TimecodeRelay ──────────────

  useEffect(() => {
    if (!enabled || !orgId) return;

    const base = relayBaseUrl ?? window.location.origin;
    const protocol = base.startsWith("https") ? "wss" : "ws";
    const host = base.replace(/^https?:\/\//, "");
    const url = `${protocol}://${host}/api/timecode/${orgId}/ws`;

    let disposed = false;
    let attempts = 0;

    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        attempts = 0;
        setConnected(true);
        // A reconnect creates a new relay session. Reclaim the source lease
        // when this browser is still actively generating timecode.
        if (internalSourceRef.current || mtcSourceRef.current) {
          ws.send(JSON.stringify({ type: "command", action: "start" }));
          ws.send(JSON.stringify({
            type: "command",
            action: "set-source",
            payload: { source: mtcSourceRef.current ? "mtc" : "internal-freerun" },
          }));
        }
      };
      ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; setConnected(false); scheduleReconnect(); };
      ws.onerror = () => setConnected(false);
      ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as TimecodeWsMessage;

        switch (msg.type) {
          case "hydrate":
            setState(msg.state);
            setEvents(msg.events);
            break;
          case "tc-update":
            setState(msg.state);
            break;
          case "events-update":
            setEvents(msg.events);
            break;
          case "event-fired":
            // Mark event as fired locally
            setEvents((prev) =>
              prev.map((e) =>
                e.id === msg.event.id ? { ...e, fired: true } : e
              )
            );
            break;
          case "master-status":
            setIsMaster(msg.granted);
            if (!msg.granted) {
              internalSourceRef.current?.stop();
              internalSourceRef.current = null;
              mtcSourceRef.current?.stop();
              mtcSourceRef.current = null;
              stopFeedTimer();
            }
            break;
        }
      } catch {
        // Ignore
      }
      };
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimerRef.current) return;
      const delay = Math.min(1_000 * 2 ** attempts, 15_000);
      attempts += 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
    };
  }, [orgId, enabled, relayBaseUrl]);

  // ─── Send command to relay ──────────────────────────────

  const sendCommand = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(
          JSON.stringify({ type: "command", action, payload })
        );
      }
    },
    []
  );

  // ─── Feed timer (sends TC to relay at 10Hz) ────────────

  const startFeedTimer = useCallback(() => {
    if (feedTimerRef.current) return;

    feedTimerRef.current = setInterval(() => {
      const latest = latestTcRef.current;
      if (latest && wsRef.current?.readyState === 1) {
        sendCommand("feed-tc", {
          timecode: latest.tc,
          totalFrames: latest.totalFrames,
          format: latest.format,
        });
      }
    }, FEED_INTERVAL_MS);
  }, [sendCommand]);

  const stopFeedTimer = useCallback(() => {
    if (feedTimerRef.current) {
      clearInterval(feedTimerRef.current);
      feedTimerRef.current = null;
    }
  }, []);

  // ─── Internal freerun source ────────────────────────────

  const startFreerun = useCallback(
    (offsetMs = 0) => {
      stopMtcFn();

      const format = state?.format ?? { frameRate: 30, dropFrame: "ndf" as const };
      formatRef.current = format;
      const source = new InternalTimecodeSource(format, (tc, totalFrames, display) => {
        latestTcRef.current = { tc, totalFrames, display, format: formatRef.current };
      });

      internalSourceRef.current = source;
      source.start(offsetMs);
      setIsMaster(true);
      startFeedTimer();
      sendCommand("start");
      sendCommand("set-source", { source: "internal-freerun" });
    },
    [state?.format, sendCommand, startFeedTimer]
  );

  const stopGenerator = useCallback(() => {
    internalSourceRef.current?.stop();
    internalSourceRef.current = null;
    mtcSourceRef.current?.stop();
    mtcSourceRef.current = null;
    stopFeedTimer();
    setIsMaster(false);
    sendCommand("stop");
  }, [sendCommand, stopFeedTimer]);

  // ─── MTC source ─────────────────────────────────────────

  const stopMtcFn = useCallback(() => {
    mtcSourceRef.current?.stop();
    mtcSourceRef.current = null;
  }, []);

    const startMtc = useCallback(
      async (inputId: string) => {
        internalSourceRef.current?.stop();
        internalSourceRef.current = null;
        stopMtcFn();

        const source = new MtcSource((tc, frameRate) => {
          const format = { frameRate, dropFrame: "ndf" as const };
          formatRef.current = format;
          const totalFrames = timecodeToFrames(tc, format);
          const display = timecodeToString(tc, false);
          latestTcRef.current = { tc, totalFrames, display, format };
        });

      await source.start(inputId);
      mtcSourceRef.current = source;
      setIsMaster(true);
      startFeedTimer();
      sendCommand("start");
      sendCommand("set-source", { source: "mtc" });
    },
    [sendCommand, startFeedTimer, stopMtcFn]
  );

  const stopMtc = useCallback(() => {
    stopMtcFn();
    stopFeedTimer();
    setIsMaster(false);
    sendCommand("stop");
  }, [stopMtcFn, sendCommand, stopFeedTimer]);

  // ─── Timecode controls ──────────────────────────────────

  const setTimecode = useCallback(
    (tc: TimecodeValue) => {
      sendCommand("set-timecode", { timecode: tc });
    },
    [sendCommand]
  );

  const setFormat = useCallback(
    (format: TimecodeFormat) => {
      formatRef.current = format;
      sendCommand("set-format", { format });
      internalSourceRef.current?.setFormat(format);
    },
    [sendCommand]
  );

  // ─── Event management ──────────────────────────────────

  const addEvent = useCallback(
    (event: Omit<AutomationEvent, "id" | "fired" | "triggerFrame">) => {
      sendCommand("add-event", event as Record<string, unknown>);
    },
    [sendCommand]
  );

  const updateEvent = useCallback(
    (id: string, updates: Partial<AutomationEvent>) => {
      sendCommand("update-event", { id, updates });
    },
    [sendCommand]
  );

  const removeEvent = useCallback(
    (id: string) => {
      sendCommand("remove-event", { id });
    },
    [sendCommand]
  );

  const resetEvents = useCallback(() => {
    sendCommand("reset-events");
  }, [sendCommand]);

  // ─── Cleanup ────────────────────────────────────────────

  useEffect(() => {
    return () => {
      internalSourceRef.current?.stop();
      mtcSourceRef.current?.stop();
      stopFeedTimer();
    };
  }, [stopFeedTimer]);

  return {
    state,
    display: state?.display ?? "00:00:00:00",
    connected,
    events,
    isMaster,
    startFreerun,
    stopGenerator,
    startMtc,
    stopMtc,
    setTimecode,
    setFormat,
    addEvent,
    updateEvent,
    removeEvent,
    resetEvents,
    mtcSupported: MtcSource.isSupported(),
  };
}
