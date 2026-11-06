import { useCallback, useEffect, useRef, useState } from "react";
import { cueSheetEventSchema, type CueSheetEvent, type CueNoteEvent, type IncidentEvent } from "@/lib/cue-sheet-events";
import { RelaySequenceTracker } from "@/lib/relay-sequence";
export type { CueSheetEvent, CueNoteEvent, IncidentEvent } from "@/lib/cue-sheet-events";

interface Options {
  orgId: string;
  /** Changing the selected show invalidates that view's outstanding refresh. */
  scope?: string;
  onNote: (event: CueNoteEvent) => void;
  onIncident?: (event: IncidentEvent) => void;
  /** Abort fetches and check the signal before applying refreshed data. */
  onRefresh: (signal: AbortSignal) => Promise<void>;
}
type SyncStatus = "connecting" | "reconnecting" | "refreshing" | "connected";
interface SyncState {
  status: SyncStatus;
  error: { message: string; occurredAt: number } | null;
}

/** D1 owns the sheet. Recovery only reads scoped data; it never replays edits. */
export function useCueSheetSync(options: Options) {
  const { orgId, scope } = options;
  const handlers = useRef(options);
  handlers.current = options;
  const [state, setState] = useState<SyncState>({ status: "connecting", error: null });
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let releaseConnection = () => {};
    let retryConnection = () => {};
    const sequence = new RelaySequenceTracker();
    const fail = (message: string) => setState({ status: "reconnecting", error: { message, occurredAt: Date.now() } });
    setState({ status: "connecting", error: null });

    const connect = () => {
      if (disposed) return;
      clearTimeout(reconnect);
      releaseConnection();
      setState(previous => ({ ...previous, status: previous.error ? "reconnecting" : "connecting" }));
      const schedule = () => { reconnect = setTimeout(connect, Math.min(1000 * 2 ** Math.min(attempts++, 4), 15000)); };
      let socket: WebSocket;
      try {
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${protocol}://${window.location.host}/api/cue-sheet/${encodeURIComponent(orgId)}/ws`);
      } catch {
        fail("Live connection could not open. Retrying automatically.");
        retryConnection = connect; schedule(); return;
      }
      wsRef.current = socket;
      let hydrateTimeout: ReturnType<typeof setTimeout> | undefined;
      let refreshRetry: ReturnType<typeof setTimeout> | undefined;
      let request: { controller: AbortController; timeout?: ReturnType<typeof setTimeout> } | null = null;
      let refreshAgain = false;
      let awaitingSnapshot = true;
      let synchronized = false;
      let buffered: CueSheetEvent[] = [];
      const current = () => !disposed && wsRef.current === socket;
      const cancelRead = () => {
        const pending = request; request = null;
        clearTimeout(pending?.timeout); pending?.controller.abort();
      };
      releaseConnection = () => {
        if (wsRef.current === socket) wsRef.current = null;
        clearTimeout(hydrateTimeout); clearTimeout(refreshRetry); cancelRead();
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close(); sequence.disconnect();
      };
      const disconnect = (message: string) => {
        if (!current()) return;
        releaseConnection(); fail(message); schedule();
      };
      const deliver = (message: CueSheetEvent) => {
        if (message.type === "note") handlers.current.onNote(message);
        else if (message.type === "incident") handlers.current.onIncident?.(message);
      };
      const refresh = async () => {
        if (!current() || request || awaitingSnapshot) return;
        const pending = { controller: new AbortController(), timeout: undefined as ReturnType<typeof setTimeout> | undefined };
        request = pending; buffered = []; synchronized = false;
        setState(previous => ({ ...previous, status: "refreshing" }));
        clearTimeout(refreshRetry);
        try {
          await Promise.race([
            handlers.current.onRefresh(pending.controller.signal),
            new Promise<never>((_, reject) => {
              pending.timeout = setTimeout(() => {
                reject(new Error("Refresh timed out. Try again.")); pending.controller.abort();
              }, 10_000);
            }),
          ]);
          if (!current() || request !== pending || refreshAgain || awaitingSnapshot) return;
          for (const message of buffered) deliver(message);
          buffered = []; synchronized = true; attempts = 0;
          setState({ status: "connected", error: null });
        } catch (error) {
          if (!current() || request !== pending) return;
          fail(error instanceof Error ? error.message : "Could not refresh live changes. Try again.");
          refreshRetry = setTimeout(() => { void refresh(); }, Math.min(5000 * 2 ** Math.min(attempts++, 3), 30_000));
        } finally {
          clearTimeout(pending.timeout);
          if (request === pending) {
            request = null;
            if (current() && refreshAgain && !awaitingSnapshot) { refreshAgain = false; void refresh(); }
          }
        }
      };
      retryConnection = () => {
        if (current() && socket.readyState === WebSocket.OPEN && !awaitingSnapshot) void refresh();
        else connect();
      };
      const awaitHydrate = () => {
        clearTimeout(hydrateTimeout);
        hydrateTimeout = setTimeout(() => disconnect("Live connection timed out. Retrying automatically."), 5000);
      };
      // Bound CONNECTING too; some networks never dispatch open/error/close.
      awaitHydrate();
      socket.onopen = () => { if (current()) awaitHydrate(); };
      socket.onmessage = event => {
        if (!current()) return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (message && typeof message === "object" && "type" in message && message.type === "hydrate") {
            clearTimeout(hydrateTimeout); awaitingSnapshot = false;
            const { changed } = sequence.snapshot(message);
            if (request) refreshAgain ||= changed;
            else { refreshAgain = false; void refresh(); }
            return;
          }
          const result = cueSheetEventSchema.safeParse(message);
          if (!result.success) return;
          const decision = sequence.delta(message);
          if (decision === "refresh") {
            synchronized = false; awaitingSnapshot = true; refreshAgain = true;
            setState(previous => ({ ...previous, status: "refreshing" })); awaitHydrate();
            socket.send(JSON.stringify({ type: "sync", lastSeenSequence: sequence.lastSeenSequence }));
          }
          if (decision !== "apply") return;
          if (result.data.type === "columns") {
            // Columns have no delta payload; D1 must confirm them before Synced.
            if (request) refreshAgain = true;
            else void refresh();
            return;
          }
          if (request) {
            buffered.push(result.data);
            if (buffered.length > 1000) disconnect("Live changes need a fresh snapshot. Reconnecting.");
          } else if (synchronized) deliver(result.data);
        } catch { disconnect("Live changes could not be read. Reconnecting."); }
      };
      socket.onclose = () => disconnect("Live connection lost. Retrying automatically.");
      socket.onerror = () => disconnect("Live connection failed. Retrying automatically.");
    };
    retryRef.current = () => retryConnection();
    connect();
    return () => {
      disposed = true; clearTimeout(reconnect); releaseConnection(); retryRef.current = () => {};
    };
  }, [orgId, scope]);

  // Publication follows the D1 commit. A lost notification is recovered by the
  // next read, never by replaying the write or rejecting an already saved note.
  const publish = useCallback((event: CueSheetEvent) => {
    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(event)); }
    catch { socket.close(); }
  }, []);
  const retrySync = useCallback(() => retryRef.current(), []);
  return { connected: state.status === "connected", status: state.status, publish, syncError: state.error?.message ?? null, syncErrorAt: state.error?.occurredAt ?? null, retrySync };
}
