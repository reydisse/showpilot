import { RelaySequenceTracker } from "@showpilot/shared";
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
  type MobileTimecodeTarget,
} from "@/lib/timecode-contract";

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

function relayUrl(orgId: string, showId: string) {
  const url = new URL(SHOWPILOT_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/timecode/${encodeURIComponent(orgId)}/ws`;
  url.searchParams.set("showId", showId);
  return url.toString();
}

type Control = "available" | "yours" | "other";
type Pending = "start" | "stop" | "claim-control" | "release-control" | null;
function isControl(value: unknown): value is Control {
  return value === "available" || value === "yours" || value === "other";
}
type Actions = {
  start(): void;
  stop(): void;
  claim(): void;
  release(): void;
  retry(): void;
  refresh(): Promise<boolean>;
};

export function useTimecodeRelay(
  orgId: string | undefined,
  seed: { state: MobileTimecodeState; events: MobileTimecodeEvent[] } | undefined,
  { showId, serviceDate }: MobileTimecodeTarget,
) {
  const [state, setState] = useState<MobileTimecodeState | null>(null);
  const [events, setEvents] = useState<MobileTimecodeEvent[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [control, setControl] = useState<Control | null>(null);
  const [isMaster, setIsMaster] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const actions = useRef<Actions | null>(null);
  const seedRef = useRef(seed);
  seedRef.current = seed;

  useEffect(() => {
    setState(null); setEvents([]); setControl(null);
    setPending(null); setIsMaster(false); setCommandError(null);
    if (!orgId) { setStatus("offline"); return; }
    let disposed = false;
    let generation = 0;
    let attempts = 0;
    let socket: WebSocket | null = null;
    let ready = false;
    let owner: Control | null = null;
    let current: MobileTimecodeState | null = null;
    let operation: Pending = null;
    let granted = false;
    let startReview: Pick<MobileTimecodeState, "totalFrames" | "format"> | null = null;
    let generator: { startAt: number; startFrames: number; format: TimecodeFormat } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    let syncDeadline: ReturnType<typeof setTimeout> | undefined;
    let feedTimer: ReturnType<typeof setInterval> | undefined;
    let authentication: AbortController | null = null;
    const sequence = new RelaySequenceTracker();
    let syncNumber = 0;
    let syncRequest: { id: string; complete: (confirmed: boolean) => void } | null = null;
    const matches = (value: MobileTimecodeTarget) => value.showId === showId && value.serviceDate === serviceDate;
    // HTTP data is only a last-known initial fallback. Later polls cannot rewind
    // an authoritative socket or replace a live timeline with an older read.
    const initial = seedRef.current;
    if (initial && matches(initial.state)) { current = initial.state; setState(current); setEvents(initial.events); }

    const finishOperation = () => {
      clearTimeout(operationTimer); operationTimer = undefined;
      operation = null; setPending(null);
    };
    const stopFeed = () => {
      clearInterval(feedTimer); feedTimer = undefined;
      generator = null; granted = false; startReview = null; setIsMaster(false);
    };
    const retire = (message?: string, reconnect = true) => {
      generation++;
      authentication?.abort(); authentication = null;
      ready = false; owner = null; setControl(null); sequence.disconnect();
      if (operation || generator) setCommandError("The clock connection was interrupted. Review the current show state before acting again. Commands are not replayed.");
      stopFeed(); finishOperation();
      syncRequest?.complete(false); syncRequest = null;
      clearTimeout(handshakeTimer); clearTimeout(syncTimer); clearTimeout(syncDeadline);
      handshakeTimer = syncTimer = syncDeadline = undefined;
      const previous = socket; socket = null;
      previous?.close();
      if (message) setConnectionError(message);
      if (disposed) return;
      setStatus(AppState.currentState === "active" ? "reconnecting" : "offline");
      if (reconnect && AppState.currentState === "active" && !reconnectTimer) {
        reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, Math.min(1_000 * 2 ** attempts++, 15_000));
      }
    };
    const send = (action: string, payload?: Record<string, unknown>) => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) {
        setCommandError("Timecode is not connected. The command was not sent."); return false;
      }
      if (owner === "other") { setCommandError("Another operator controls timecode. Ask them to release control first."); return false; }
      try { socket.send(JSON.stringify({ type: "command", action, payload })); return true; }
      catch { retire("The timecode command could not be sent. Reconnect and review the current state."); return false; }
    };
    const begin = (action: Exclude<Pending, null>, payload?: Record<string, unknown>) => {
      if (operation) return;
      operation = action; setPending(action); setCommandError(null);
      if (!send(action, payload)) { finishOperation(); return; }
      operationTimer = setTimeout(() => {
        retire();
        setCommandError("The timecode command was not confirmed. It may have completed. Review the refreshed show before trying again.");
      }, 8_000);
    };
    const feed = () => {
      if (!generator || !granted || !ready) return;
      const totalFrames = generator.startFrames + Math.floor((Date.now() - generator.startAt) / 1_000 * generator.format.frameRate);
      send("feed-tc", { timecode: framesToTimecode(totalFrames, generator.format), totalFrames, format: generator.format });
    };
    const confirmClock = () => {
      if (!current) return;
      if (operation === "start" && granted && current.running) {
        if (!startReview || current.totalFrames !== startReview.totalFrames || current.format.frameRate !== startReview.format.frameRate || current.format.dropFrame !== startReview.format.dropFrame) {
          send("stop"); retire();
          setCommandError("The relay did not confirm the reviewed start position. This generator was not started.");
          return;
        }
        generator = { startAt: Date.now(), startFrames: current.totalFrames, format: current.format };
        finishOperation(); setIsMaster(true); feed();
        if (generator) feedTimer = setInterval(feed, FEED_INTERVAL_MS);
      } else if (operation === "stop" && !current.running) {
        stopFeed(); finishOperation();
      } else if (generator && !current.running) {
        stopFeed();
      }
    };
    const requestSync = (): Promise<boolean> => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);
      // A save refresh must be newer than the save acknowledgement. A previous
      // periodic sync cannot confirm it, even if that old response arrives late.
      syncRequest?.complete(false);
      clearTimeout(syncTimer); clearTimeout(syncDeadline);
      const id = `${generation}-${++syncNumber}`;
      const completion = new Promise<boolean>(complete => { syncRequest = { id, complete }; });
      syncDeadline = setTimeout(() => retire("The timecode connection stopped responding. Showing last known state."), 8_000);
      try { socket.send(JSON.stringify({ type: "sync", syncId: id, lastSeenSequence: sequence.lastSeenSequence })); }
      catch { retire("Timecode could not refresh its current state."); }
      return completion;
    };
    const connect = async () => {
      if (disposed || AppState.currentState !== "active" || socket || authentication) return;
      const attempt = ++generation;
      const active = () => !disposed && attempt === generation;
      setStatus(attempts ? "reconnecting" : "connecting");
      authentication = new AbortController();
      handshakeTimer = setTimeout(() => { if (active()) retire("The timecode connection timed out. Retry to load the current show."); }, 12_000);
      let ws: WebSocket;
      try { ws = await createAuthenticatedWebSocket(relayUrl(orgId, showId), undefined, authentication.signal); }
      catch (error) {
        if (active()) retire(error instanceof Error ? error.message : "Timecode authentication failed.");
        return;
      }
      if (!active()) { ws.close(); return; }
      authentication = null; socket = ws;
      ws.onopen = () => { /* Connected requires the server's full snapshot. */ };
      ws.onmessage = event => {
        if (!active() || socket !== ws || typeof event.data !== "string") return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (!isRecord(message) || typeof message.type !== "string") throw new Error("Invalid update");
          if (message.showId !== showId || message.serviceDate !== serviceDate) throw new Error("Wrong show");
          const isControlMessage = ["master-status", "control-status", "command-rejected"].includes(message.type);
          if (message.type !== "hydrate" && !isControlMessage) {
            const decision = sequence.delta(message);
            if (decision === "refresh") {
              // Losing any timeline update also invalidates permission to feed.
              retire("A timecode update was missed. Reconnecting to confirm the current show."); return;
            }
            if (decision !== "apply") return;
          }
          if (message.type === "hydrate" || message.type === "tc-update") {
            const next = parseMobileTimecodeState(message.state);
            if (!next || !matches(next)) throw new Error("Invalid timecode state");
            if (message.type === "hydrate") {
              if (message.syncId !== undefined && message.syncId !== syncRequest?.id) return;
              const nextEvents = parseMobileTimecodeEvents(message.events);
              if (!nextEvents || !isControl(message.control)) throw new Error("Invalid timecode snapshot");
              sequence.snapshot(message); owner = message.control; setControl(owner); setEvents(nextEvents);
              if (owner === "other") { stopFeed(); finishOperation(); }
              clearTimeout(handshakeTimer); handshakeTimer = undefined;
              ready = true; attempts = 0; setStatus("connected"); setConnectionError(null);
              if (!syncRequest || message.syncId === syncRequest.id) {
                syncRequest?.complete(true); syncRequest = null;
                clearTimeout(syncDeadline); clearTimeout(syncTimer); syncDeadline = undefined;
                syncTimer = setTimeout(() => { void requestSync(); }, 20_000);
              }
            }
            current = next; setState(next); confirmClock();
          } else if (message.type === "events-update") {
            const next = parseMobileTimecodeEvents(message.events);
            if (!next) throw new Error("Invalid events");
            setEvents(next);
          } else if (message.type === "event-fired") {
            const next = parseMobileTimecodeEvent(message.event);
            if (!next) throw new Error("Invalid event");
            setEvents(previous => previous.map(item => item.id === next.id ? next : item));
          } else if (message.type === "lyrics-update" || message.type === "lyrics-clear") {
            const next = parseMobileTimecodeState({ ...current, lyrics: message.type === "lyrics-clear" ? null : message.lyrics });
            if (!next) throw new Error("Invalid lyrics");
            current = next; setState(next);
          } else if (message.type === "control-status") {
            if (!isControl(message.control)) throw new Error("Invalid control status");
            owner = message.control; setControl(owner);
            if (operation === "claim-control" && owner === "yours" || operation === "release-control" && owner === "available") finishOperation();
            if (owner === "other") {
              if (generator || operation) setCommandError("Another operator now controls timecode. This device's clock was stopped.");
              stopFeed(); finishOperation();
            }
          } else if (message.type === "master-status") {
            if (typeof message.granted !== "boolean") throw new Error("Invalid master status");
            if (message.granted && operation === "start") { granted = true; confirmClock(); }
            else if (!message.granted) {
              stopFeed();
              if (operation === "start") { finishOperation(); setCommandError("Another source owns the timecode generator. This clock was not started."); }
            }
          } else if (message.type === "command-rejected") {
            if (typeof message.error !== "string") throw new Error("Invalid rejection");
            setCommandError(message.error);
            if (["start", "feed-tc", "set-source", "stop"].includes(String(message.action))) stopFeed();
            if (message.action === operation) finishOperation();
          }
        } catch { retire("ShowPilot received an unreadable timecode update. Reconnecting to confirm the show state."); }
      };
      ws.onerror = () => { if (active()) retire("The timecode connection was interrupted. Showing last known state."); };
      ws.onclose = () => { if (active()) retire("Timecode disconnected. Showing last known state."); };
    };
    const retry = () => {
      retire(undefined, false); clearTimeout(reconnectTimer); reconnectTimer = undefined;
      void connect();
    };
    actions.current = {
      start: () => {
        if (owner === "other") { setCommandError("Another operator controls timecode. Ask them to release control first."); return; }
        if (!current || !ready) { setCommandError("Live timecode state is not ready. Start was not sent."); return; }
        if (generator || operation) return;
        if (current.running) { setCommandError("The clock is already running. Stop the current source first."); return; }
        startReview = { totalFrames: current.totalFrames, format: current.format };
        begin("start", { startPosition: { expectedShowId: showId, expectedFormat: current.format, expectedFrame: current.totalFrames, timecode: current.timecode, confirmed: true } });
      },
      stop: () => { if (operation === "start") finishOperation(); stopFeed(); begin("stop"); },
      claim: () => begin("claim-control"),
      release: () => {
        if (generator || operation) { setCommandError("Stop the local clock before releasing control."); return; }
        begin("release-control");
      },
      retry, refresh: requestSync,
    };
    const subscription = AppState.addEventListener("change", next => {
      if (next === "active") void connect();
      else { retire(undefined, false); clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    });
    void connect();
    return () => {
      disposed = true; actions.current = null; subscription.remove();
      clearTimeout(reconnectTimer); retire(undefined, false);
    };
  }, [orgId, showId, serviceDate]);

  const startFreerun = useCallback(() => actions.current?.start(), []);
  const stopFreerun = useCallback(() => actions.current?.stop(), []);
  const claimControl = useCallback(() => actions.current?.claim(), []);
  const releaseControl = useCallback(() => actions.current?.release(), []);
  const retryConnection = useCallback(() => actions.current?.retry(), []);
  const refresh = useCallback(() => actions.current?.refresh() ?? Promise.resolve(false), []);
  const dismissCommandError = useCallback(() => setCommandError(null), []);
  return { state, events, status, control, isMaster, pending, starting: pending === "start", stopping: pending === "stop",
    lastError: commandError ?? connectionError, commandError, startFreerun, stopFreerun, claimControl, releaseControl, retryConnection, refresh, dismissCommandError };
}
