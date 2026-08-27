import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { createAuthenticatedWebSocket } from "@/lib/auth-transport";
import { SHOWPILOT_URL } from "@/lib/env";
import {
  parseMobileTimecodeEvent,
  parseMobileTimecodeEvents,
  parseMobileTimecodeState,
  type MobileTimecodeEvent,
  type MobileTimecodeState,
} from "@/lib/mobile-api";

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline";
type TimecodeFormat = MobileTimecodeState["format"];

const FEED_INTERVAL_MS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function framesToTimecode(totalFrames: number, format: TimecodeFormat) {
  const fps = Math.round(format.frameRate);
  if (format.frameRate === 29.97 && format.dropFrame === "df") {
    const framesPerMinute = 1_798;
    const framesPerTenMinutes = 17_982;
    const tenMinuteBlocks = Math.floor(totalFrames / framesPerTenMinutes);
    const remainder = totalFrames % framesPerTenMinutes;
    const adjusted = totalFrames + (2 * tenMinuteBlocks * 9)
      + (remainder > 2 ? 2 * Math.floor((remainder - 2) / framesPerMinute) : 0);
    return {
      hours: Math.floor(adjusted / 108_000) % 24,
      minutes: Math.floor(adjusted / 1_800) % 60,
      seconds: Math.floor(adjusted / 30) % 60,
      frames: adjusted % 30,
    };
  }
  const dayFrames = fps * 60 * 60 * 24;
  const normalized = totalFrames % dayFrames;
  return {
    hours: Math.floor(normalized / (fps * 3_600)),
    minutes: Math.floor(normalized / (fps * 60)) % 60,
    seconds: Math.floor(normalized / fps) % 60,
    frames: normalized % fps,
  };
}

function relayUrl(orgId: string) {
  const url = new URL(SHOWPILOT_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/timecode/${encodeURIComponent(orgId)}/ws`;
  return url.toString();
}

export function useTimecodeRelay(
  orgId: string | undefined,
  seed: { state: MobileTimecodeState; events: MobileTimecodeEvent[] } | undefined,
) {
  const [state, setState] = useState<MobileTimecodeState | null>(seed?.state ?? null);
  const [events, setEvents] = useState<MobileTimecodeEvent[]>(seed?.events ?? []);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [isMaster, setIsMaster] = useState(false);
  const [starting, setStarting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<MobileTimecodeState | null>(seed?.state ?? null);
  const generatorRef = useRef<{ startAt: number; startFrames: number; format: TimecodeFormat } | null>(null);
  const feedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!seed) return;
    stateRef.current = seed.state;
    setState(seed.state);
    setEvents(seed.events);
  }, [seed]);

  const sendCommand = useCallback((action: string, payload?: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "command", action, payload }));
    return true;
  }, []);

  const stopFeed = useCallback(() => {
    if (feedTimerRef.current) clearInterval(feedTimerRef.current);
    feedTimerRef.current = null;
    generatorRef.current = null;
  }, []);

  const feed = useCallback(() => {
    const generator = generatorRef.current;
    if (!generator || generator.startAt === 0) return;
    const elapsedSeconds = (Date.now() - generator.startAt) / 1_000;
    const totalFrames = generator.startFrames + Math.floor(elapsedSeconds * generator.format.frameRate);
    sendCommand("feed-tc", {
      timecode: framesToTimecode(totalFrames, generator.format),
      totalFrames,
      format: generator.format,
    });
  }, [sendCommand]);

  const startFreerun = useCallback(() => {
    const current = stateRef.current;
    if (!current) {
      setLastError("Live timecode state is not ready yet.");
      return;
    }
    if (generatorRef.current) return;
    if (!sendCommand("start")) {
      setLastError("The live relay is reconnecting. Try again when it is connected.");
      return;
    }
    generatorRef.current = { startAt: 0, startFrames: current.totalFrames, format: current.format };
    setStarting(true);
    setLastError(null);
  }, [sendCommand]);

  const stopFreerun = useCallback(() => {
    stopFeed();
    sendCommand("stop");
    setIsMaster(false);
    setStarting(false);
  }, [sendCommand, stopFeed]);

  useEffect(() => {
    if (!orgId) {
      setStatus("offline");
      return;
    }
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer || AppState.currentState !== "active") return;
      setStatus("reconnecting");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, Math.min(1_000 * 2 ** attempts++, 15_000));
    };

    const connect = async () => {
      if (disposed || AppState.currentState !== "active") return;
      setStatus(attempts ? "reconnecting" : "connecting");
      let socket: WebSocket;
      try {
        socket = await createAuthenticatedWebSocket(relayUrl(orgId));
      } catch (error) {
        setLastError(error instanceof Error ? error.message : "Live relay authentication failed.");
        scheduleReconnect();
        return;
      }
      if (disposed) {
        socket.close();
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        attempts = 0;
        setStatus("connected");
        setLastError(null);
        if (generatorRef.current) {
          generatorRef.current.startAt = 0;
          setStarting(true);
          sendCommand("start");
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (!isRecord(message) || typeof message.type !== "string") return;
          if (message.type === "hydrate" || message.type === "tc-update") {
            const next = parseMobileTimecodeState(message.state);
            if (!next) throw new Error("Invalid timecode state");
            stateRef.current = next;
            setState(next);
          }
          if (message.type === "hydrate" || message.type === "events-update") {
            const nextEvents = parseMobileTimecodeEvents(message.events);
            if (!nextEvents) throw new Error("Invalid timecode events");
            setEvents(nextEvents);
          }
          if (message.type === "event-fired") {
            const firedEvent = parseMobileTimecodeEvent(message.event);
            if (!firedEvent) throw new Error("Invalid fired event");
            const eventId = firedEvent.id;
            setEvents((current) => current.map((item) => item.id === eventId ? { ...item, fired: true } : item));
          }
          if (message.type === "master-status" && typeof message.granted === "boolean") {
            setIsMaster(message.granted);
            const generator = generatorRef.current;
            if (message.granted && generator) {
              generator.startAt = Date.now();
              setStarting(false);
              sendCommand("set-source", { source: "internal-freerun" });
              if (feedTimerRef.current) clearInterval(feedTimerRef.current);
              feed();
              feedTimerRef.current = setInterval(feed, FEED_INTERVAL_MS);
            } else if (!message.granted && generator) {
              stopFeed();
              setStarting(false);
              setLastError("Another operator owns the timecode generator.");
            }
          }
        } catch {
          setLastError("ShowPilot received an unreadable timecode update.");
        }
      };
      socket.onerror = () => setLastError("The live timecode connection was interrupted.");
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        setIsMaster(false);
        scheduleReconnect();
      };
    };

    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void connect();
      else {
        setStatus("offline");
        socketRef.current?.close();
      }
    });
    void connect();
    return () => {
      disposed = true;
      subscription.remove();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopFeed();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [feed, orgId, sendCommand, stopFeed]);

  return { state, events, status, isMaster, starting, lastError, startFreerun, stopFreerun };
}
