import { useState, useEffect, useRef, useCallback } from "react";
import type {
  TimecodeState,
  TimecodeFormat,
  TimecodeValue,
  AutomationEvent,
  LyricsDisplayState,
  TimecodeWsMessage,
  TimecodeCommand,
  TimecodeControlStatus,
} from "@/types/timecode";
import { timecodeToFrames } from "@/lib/timecode";
import { InternalTimecodeSource } from "@/lib/timecode-sources/internal-source";
import { createBrowserId } from "@/lib/browser-id";
import { MtcSource } from "@/lib/timecode-sources/mtc-source";
import { RelaySequenceTracker } from "@/lib/relay-sequence";

interface UseTimecodeOptions {
  orgId: string;
  showId: string | null;
  enabled: boolean;
  /** Base URL for the timecode relay WebSocket */
  relayBaseUrl?: string;
}

export type NewAutomationEvent = Omit<AutomationEvent, "id" | "fired" | "triggerFrame"> & { id?: string };
export type TimecodeSendResult = { status: "sent" } | { status: "failed"; error: string };

export interface UseTimecodeReturn {
  state: TimecodeState | null;
  display: string;
  connected: boolean;
  events: AutomationEvent[];
  isMaster: boolean;
  control: TimecodeControlStatus | null;
  claimControl: () => void;
  releaseControl: () => void;
  generatorPending: "starting" | "stopping" | null;
  lastError: string | null;

  // Master controls
  startFreerun: (offsetMs?: number) => TimecodeSendResult;
  stopGenerator: () => void;
  startMtc: (inputId: string, options?: { sysex: boolean }) => Promise<void>;
  stopMtc: () => void;
  setTimecode: (tc: TimecodeValue) => void;
  setFormat: (format: TimecodeFormat, expectedFormat: TimecodeFormat, expectedIncomingFormatId?: string) => void;

  // Event management
  addEvent: (event: NewAutomationEvent) => Promise<void>;
  replaceEventGroup: (sourceKey: string, events: AutomationEvent[], options?: { onlyIfEmpty: boolean }) => Promise<void>;
  updateEvent: (id: string, updates: Partial<AutomationEvent>) => void;
  removeEvent: (id: string) => void;
  resetEvents: () => void;
  retryEvent: (id: string) => void;
  setEventEnabled: (id: string, enabled: boolean) => void;
  setTriggersEnabled: (enabled: boolean, expectedHoldId?: string) => void;
  setLyrics: (lyrics: Omit<LyricsDisplayState, "updatedAt" | "manual">) => void;
  clearLyrics: () => void;

  // MTC support
  mtcSupported: boolean;
}

const FEED_INTERVAL_MS = 100;
const CONFIRM_TIMEOUT_MS = 5_000;
type PendingSource =
  | { kind: "internal"; offsetMs: number | undefined }
  | { kind: "mtc"; source: MtcSource };
type PendingEdit = {
  matches: (events: AutomationEvent[]) => boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export function useTimecode({ orgId, showId, enabled, relayBaseUrl }: UseTimecodeOptions): UseTimecodeReturn {
  const requestedScope = useRef({ orgId, showId });
  requestedScope.current = { orgId, showId };
  const confirmedScope = useRef<{ orgId: string; showId: string } | null>(null);
  const [state, setState] = useState<TimecodeState | null>(null);
  const [events, setEvents] = useState<AutomationEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [isMaster, setIsMaster] = useState(false);
  const [control, setControl] = useState<TimecodeControlStatus | null>(null);
  const controlRef = useRef<TimecodeControlStatus | null>(null);
  const [generatorPending, setGeneratorPending] = useState<"starting" | "stopping" | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [mtcSupported, setMtcSupported] = useState(false);
  useEffect(() => { setMtcSupported(MtcSource.isSupported()); }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const stateRef = useRef<TimecodeState | null>(null);
  const internalSourceRef = useRef<InternalTimecodeSource | null>(null);
  const mtcSourceRef = useRef<MtcSource | null>(null);
  const pendingSourceRef = useRef<PendingSource | null>(null);
  const masterGrantedRef = useRef(false);
  const generatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingEditsRef = useRef(new Set<PendingEdit>());
  const latestTcRef = useRef<{ tc: TimecodeValue; totalFrames: number; format: TimecodeFormat } | null>(null);
  const formatRef = useRef<TimecodeFormat>({ frameRate: 30, dropFrame: "ndf" });

  const clearGeneratorTimeout = useCallback(() => {
    if (generatorTimeoutRef.current !== null) clearTimeout(generatorTimeoutRef.current);
    generatorTimeoutRef.current = null;
  }, []);
  const stopLocalSources = useCallback(() => {
    internalSourceRef.current?.stop();
    mtcSourceRef.current?.stop();
    if (pendingSourceRef.current?.kind === "mtc") pendingSourceRef.current.source.stop();
    internalSourceRef.current = null;
    mtcSourceRef.current = null;
    pendingSourceRef.current = null;
    masterGrantedRef.current = false;
    latestTcRef.current = null;
    if (feedTimerRef.current !== null) clearInterval(feedTimerRef.current);
    feedTimerRef.current = null;
    clearGeneratorTimeout();
    setIsMaster(false);
    setGeneratorPending(null);
  }, [clearGeneratorTimeout]);

  const sendCommand = useCallback((action: TimecodeCommand, payload?: Record<string, unknown>): TimecodeSendResult => {
    const ws = wsRef.current;
    if (!readyRef.current || ws?.readyState !== 1
      || confirmedScope.current?.orgId !== requestedScope.current.orgId
      || confirmedScope.current?.showId !== requestedScope.current.showId) {
      const error = "Timecode disconnected. Reconnect before sending this command.";
      setLastError(error);
      return { status: "failed", error };
    }
    if (controlRef.current === "other") {
      const error = "Another operator controls timecode. Ask them to release control first.";
      setLastError(error);
      return { status: "failed", error };
    }
    try {
      ws.send(JSON.stringify({ type: "command", action, payload }));
      return { status: "sent" };
    } catch {
      const error = "Timecode command could not be sent. Reconnect and review live state.";
      setLastError(error);
      ws.close();
      return { status: "failed", error };
    }
  }, []);

  const startFeedTimer = useCallback(() => {
    if (feedTimerRef.current !== null) return;
    feedTimerRef.current = setInterval(() => {
      const latest = latestTcRef.current;
      if (latest && masterGrantedRef.current) sendCommand("feed-tc", {
        timecode: latest.tc, totalFrames: latest.totalFrames, format: latest.format,
      });
      // A feed is proof of a new source callback, not proof that this timer is
      // still running. Repeating a stale MTC frame hides cable/DAW signal loss.
      latestTcRef.current = null;
    }, FEED_INTERVAL_MS);
  }, [sendCommand]);

  const startConfirmedSource = useCallback((relayState: TimecodeState) => {
    const pending = pendingSourceRef.current;
    if (!pending || !masterGrantedRef.current || !relayState.running) return;
    const result = sendCommand("set-source", { source: pending.kind === "internal" ? "internal-freerun" : "mtc" });
    if (result.status === "failed") { stopLocalSources(); return; }
    formatRef.current = relayState.format;
    if (pending.kind === "internal") {
      const source = new InternalTimecodeSource(relayState.format, (tc, totalFrames) => {
        latestTcRef.current = { tc, totalFrames, format: formatRef.current };
      });
      internalSourceRef.current = source;
      if (pending.offsetMs === undefined) source.startAtFrame(relayState.totalFrames);
      else source.start(pending.offsetMs);
    } else {
      mtcSourceRef.current = pending.source;
      const transport = pending.source.transportState;
      if (transport && sendCommand("mtc-transport", { state: transport }).status === "failed") { stopLocalSources(); return; }
    }
    pendingSourceRef.current = null;
    clearGeneratorTimeout();
    setIsMaster(true);
    setGeneratorPending(null);
    startFeedTimer();
  }, [clearGeneratorTimeout, sendCommand, startFeedTimer, stopLocalSources]);

  useEffect(() => {
    setState(null); stateRef.current = null; setEvents([]); setLastError(null);
    controlRef.current = null; setControl(null);
    setConnected(false); readyRef.current = false; confirmedScope.current = null;
    if (!enabled || !orgId || !showId) return;
    const base = relayBaseUrl ?? window.location.origin;
    const url = `${base.startsWith("https") ? "wss" : "ws"}://${base.replace(/^https?:\/\//, "")}/api/timecode/${encodeURIComponent(orgId)}/ws?showId=${encodeURIComponent(showId)}`;
    let disposed = false;
    const sequence = new RelaySequenceTracker();
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const failEdits = (message: string) => {
      for (const edit of pendingEditsRef.current) { clearTimeout(edit.timeout); edit.reject(new Error(message)); }
      pendingEditsRef.current.clear();
    };
    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, Math.min(1_000 * 2 ** attempts++, 15_000));
    };
    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
      wsRef.current = ws;
      let hydrateTimeout: ReturnType<typeof setTimeout> | undefined;
      const current = () => !disposed && wsRef.current === ws && requestedScope.current.orgId === orgId && requestedScope.current.showId === showId;
      const awaitHydrate = () => { clearTimeout(hydrateTimeout); hydrateTimeout = setTimeout(() => { if (current()) ws.close(); }, CONFIRM_TIMEOUT_MS); };
      ws.onopen = () => { if (current()) { attempts = 0; awaitHydrate(); } };
      ws.onclose = () => {
        clearTimeout(hydrateTimeout);
        if (!current()) return;
        wsRef.current = null; readyRef.current = false; confirmedScope.current = null; setConnected(false);
        sequence.disconnect();
        controlRef.current = null; setControl(null);
        if (internalSourceRef.current || mtcSourceRef.current || pendingSourceRef.current) {
          setLastError("Timecode disconnected. The local source stopped; reconnect before starting again.");
        }
        stopLocalSources();
        failEdits("Timecode disconnected before the save was confirmed. Your changes have been kept in the form.");
        scheduleReconnect();
      };
      ws.onerror = () => { if (current()) ws.close(); };
      ws.onmessage = (event) => {
        if (!current()) return;
        try {
          const msg = JSON.parse(event.data) as TimecodeWsMessage;
          if (msg.type !== "hydrate" && msg.type !== "master-status" && msg.type !== "control-status" && msg.type !== "command-rejected") {
            const decision = sequence.delta(msg);
            if (decision === "refresh") {
              readyRef.current = false; setConnected(false); awaitHydrate();
              ws.send(JSON.stringify({ type: "sync", lastSeenSequence: sequence.lastSeenSequence } satisfies TimecodeWsMessage));
            }
            if (decision !== "apply") return;
          }
          switch (msg.type) {
            case "hydrate":
              if ("source" in msg.state && "events" in msg) {
                if (msg.state.showId !== showId) { setLastError("Timecode show mismatch. Reconnecting."); ws.close(); break; }
                clearTimeout(hydrateTimeout);
                sequence.snapshot(msg);
                controlRef.current = msg.control ?? "available"; setControl(controlRef.current);
                stateRef.current = msg.state; formatRef.current = msg.state.format;
                confirmedScope.current = { orgId, showId };
                setState(msg.state); setEvents(msg.events); readyRef.current = true; setConnected(true);
                for (const edit of pendingEditsRef.current) {
                  if (!edit.matches(msg.events)) continue;
                  clearTimeout(edit.timeout); pendingEditsRef.current.delete(edit); edit.resolve();
                }
                startConfirmedSource(msg.state);
              }
              break;
            case "tc-update":
              if ("source" in msg.state) {
                if (msg.state.showId !== showId) { setLastError("Timecode show mismatch. Reconnecting."); ws.close(); break; }
                stateRef.current = msg.state; formatRef.current = msg.state.format;
                internalSourceRef.current?.setFormat(msg.state.format);
                setState(msg.state);
                if (!msg.state.running && !pendingSourceRef.current
                  && msg.state.signal?.status !== "timecode-stalled"
                  && msg.state.signal?.status !== "timecode-lost"
                  && msg.state.signal?.status !== "format-mismatch"
                  && msg.state.signal?.status !== "midi-stopped"
                  && msg.state.signal?.status !== "midi-waiting"
                  && msg.state.signal?.status !== "waiting") stopLocalSources();
                startConfirmedSource(msg.state);
              }
              break;
            case "events-update":
              setEvents(msg.events);
              for (const edit of pendingEditsRef.current) {
                if (!edit.matches(msg.events)) continue;
                clearTimeout(edit.timeout); pendingEditsRef.current.delete(edit); edit.resolve();
              }
              break;
            case "event-fired": setEvents((prev) => prev.map((e) => e.id === msg.event.id ? msg.event : e)); break;
            case "lyrics-update": setState((prev) => prev ? { ...prev, lyrics: msg.lyrics } : prev); break;
            case "lyrics-clear": setState((prev) => prev ? { ...prev, lyrics: null } : prev); break;
            case "control-status":
              controlRef.current = msg.control; setControl(msg.control);
              if (msg.control === "other") {
                stopLocalSources();
                failEdits("Another operator controls timecode. Your changes have been kept in the form.");
              }
              break;
            case "command-rejected":
              setLastError(msg.error);
              if (msg.action === "set-source" || msg.action === "start" || msg.action === "feed-tc" || msg.action === "mtc-transport") stopLocalSources();
              if (msg.action === "add-event" || msg.action === "replace-event-group") failEdits(msg.error);
              break;
            case "master-status":
              if (msg.granted && pendingSourceRef.current) masterGrantedRef.current = true;
              else if (!msg.granted) {
                if (pendingSourceRef.current) setLastError("Another source controls timecode. This generator was not started.");
                stopLocalSources();
              }
              break;
          }
        } catch { /* Malformed relay frames cannot confirm a pending command. */ }
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      readyRef.current = false;
      confirmedScope.current = null;
      wsRef.current?.close(); wsRef.current = null;
      stopLocalSources();
      failEdits("The timecode workspace changed before the save was confirmed.");
    };
  }, [orgId, showId, enabled, relayBaseUrl, startConfirmedSource, stopLocalSources]);

  const awaitGenerator = useCallback(() => {
    clearGeneratorTimeout();
    generatorTimeoutRef.current = setTimeout(() => {
      setLastError("Generator change was not confirmed. Reconnect and review the clock before trying again.");
      stopLocalSources();
      wsRef.current?.close();
    }, CONFIRM_TIMEOUT_MS);
  }, [clearGeneratorTimeout, stopLocalSources]);

  const startFreerun = useCallback((offsetMs?: number): TimecodeSendResult => {
    if (pendingSourceRef.current) return { status: "failed", error: "A generator start is already pending." };
    if (!readyRef.current || wsRef.current?.readyState !== 1) return sendCommand("start");
    stopLocalSources(); setLastError(null);
    pendingSourceRef.current = { kind: "internal", offsetMs };
    setGeneratorPending("starting");
    const result = sendCommand("start");
    if (result.status === "failed") stopLocalSources(); else awaitGenerator();
    return result;
  }, [awaitGenerator, sendCommand, stopLocalSources]);

  const startMtc = useCallback(async (inputId: string, options?: { sysex: boolean }) => {
    if (!readyRef.current || wsRef.current?.readyState !== 1) {
      const message = "Timecode disconnected. Reconnect before starting MTC.";
      setLastError(message); throw new Error(message);
    }
    if (pendingSourceRef.current) throw new Error("A generator start is already pending.");
    stopLocalSources(); setLastError(null); setGeneratorPending("starting");
    const source = new MtcSource((tc, format) => {
      if (mtcSourceRef.current !== source) return;
      latestTcRef.current = { tc, format, totalFrames: timecodeToFrames(tc, format) };
    }, state => {
      if (mtcSourceRef.current !== source) return;
      latestTcRef.current = null;
      if (sendCommand("mtc-transport", { state }).status === "failed") stopLocalSources();
    });
    const pending: PendingSource = { kind: "mtc", source };
    pendingSourceRef.current = pending;
    try {
      await source.start(inputId, options);
      if (pendingSourceRef.current !== pending || !readyRef.current) {
        source.stop(); throw new Error("Timecode disconnected while opening MIDI. Try again after reconnecting.");
      }
      const result = sendCommand("start");
      if (result.status === "failed") throw new Error(result.error);
      awaitGenerator();
    } catch (cause) {
      source.stop();
      if (pendingSourceRef.current === pending) stopLocalSources();
      const error = cause instanceof Error ? cause : new Error("Could not open MIDI input.");
      setLastError(error.message); throw error;
    }
  }, [awaitGenerator, sendCommand, stopLocalSources]);

  const stopGenerator = useCallback(() => {
    const result = sendCommand("stop");
    stopLocalSources();
    if (result.status === "sent") { setGeneratorPending("stopping"); awaitGenerator(); }
  }, [awaitGenerator, sendCommand, stopLocalSources]);

  const saveEvents = useCallback((action: "add-event" | "replace-event-group", payload: Record<string, unknown>, matches: PendingEdit["matches"]): Promise<void> => {
    setLastError(null);
    return new Promise((resolve, reject) => {
      const pending: PendingEdit = { matches, resolve, reject, timeout: setTimeout(() => {
        pendingEditsRef.current.delete(pending);
        const message = "Save was not confirmed by the relay. Your changes have been kept; review the timeline before retrying.";
        setLastError(message); reject(new Error(message));
      }, CONFIRM_TIMEOUT_MS) };
      pendingEditsRef.current.add(pending);
      const result = sendCommand(action, payload);
      if (result.status === "failed") {
        clearTimeout(pending.timeout); pendingEditsRef.current.delete(pending); reject(new Error(result.error));
      }
    });
  }, [sendCommand]);

  const addEvent = useCallback((event: NewAutomationEvent) => {
    const id = event.id ?? createBrowserId();
    return saveEvents("add-event", { ...event, id }, (incoming) => incoming.some((candidate) => candidate.id === id));
  }, [saveEvents]);
  const replaceEventGroup = useCallback((sourceKey: string, nextEvents: AutomationEvent[], options?: { onlyIfEmpty: boolean }) => {
    if (stateRef.current?.running) return Promise.reject(new Error("Stop the clock before loading song cues."));
    const ids = new Set(nextEvents.map((event) => event.id));
    return saveEvents("replace-event-group", { sourceKey, events: nextEvents, requireStopped: true, requireEmpty: options?.onlyIfEmpty === true, expectedFormat: stateRef.current?.format }, (incoming) => {
      const group = incoming.filter((event) => event.sourceKey === sourceKey);
      return group.length === ids.size && group.every((event) => ids.has(event.id));
    });
  }, [saveEvents]);
  const claimControl = useCallback(() => { sendCommand("claim-control"); }, [sendCommand]);
  const releaseControl = useCallback(() => { sendCommand("release-control"); }, [sendCommand]);
  const setTimecode = useCallback((timecode: TimecodeValue) => { sendCommand("set-timecode", { timecode }); }, [sendCommand]);
  const setFormat = useCallback((format: TimecodeFormat, expectedFormat: TimecodeFormat, expectedIncomingFormatId?: string) => {
    sendCommand("set-format", { format, expectedFormat, expectedIncomingFormatId, confirmed: true });
  }, [sendCommand]);
  const updateEvent = useCallback((id: string, updates: Partial<AutomationEvent>) => { sendCommand("update-event", { id, updates }); }, [sendCommand]);
  const removeEvent = useCallback((id: string) => { sendCommand("remove-event", { id }); }, [sendCommand]);
  const resetEvents = useCallback(() => { sendCommand("reset-events"); }, [sendCommand]);
  const retryEvent = useCallback((id: string) => { sendCommand("retry-event", { id }); }, [sendCommand]);
  const setEventEnabled = useCallback((id: string, value: boolean) => { sendCommand("set-event-enabled", { id, enabled: value }); }, [sendCommand]);
  const setTriggersEnabled = useCallback((value: boolean, expectedHoldId?: string) => {
    sendCommand("set-triggers-enabled", { enabled: value, ...(expectedHoldId ? { expectedHoldId, confirmed: true } : {}) });
  }, [sendCommand]);
  const setLyrics = useCallback((lyrics: Omit<LyricsDisplayState, "updatedAt" | "manual">) => { sendCommand("set-lyrics", lyrics); }, [sendCommand]);
  const clearLyrics = useCallback(() => { sendCommand("clear-lyrics"); }, [sendCommand]);

  const visibleState = confirmedScope.current?.orgId === orgId && state?.showId === showId ? state : null;
  return {
    state: visibleState, display: visibleState?.display ?? "00:00:00:00", connected: connected && visibleState !== null,
    control: visibleState ? control : null, claimControl, releaseControl,
    events: visibleState ? events : [], isMaster: visibleState !== null && isMaster, generatorPending, lastError,
    startFreerun, stopGenerator, startMtc, stopMtc: stopGenerator, setTimecode, setFormat,
    addEvent, replaceEventGroup, updateEvent, removeEvent, resetEvents, retryEvent, setEventEnabled,
    setTriggersEnabled, setLyrics, clearLyrics, mtcSupported,
  };
}
