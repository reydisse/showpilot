import { useCallback, useEffect, useRef, useState } from "react";
import { cueSheetEventSchema, type CueSheetEvent, type CueNoteEvent, type IncidentEvent } from "@/lib/cue-sheet-events";
import { RelaySequenceTracker } from "@/lib/relay-sequence";
export type { CueSheetEvent, CueNoteEvent, IncidentEvent } from "@/lib/cue-sheet-events";

interface Options {
  orgId: string;
  onNote: (event: CueNoteEvent) => void;
  onColumns: () => void;
  onIncident?: (event: IncidentEvent) => void;
  /** Reload this view's authorized D1 data, rejecting if it could not refresh. */
  onRefresh: () => Promise<void>;
}

/** D1 owns the sheet. The socket detects missing notifications and makes the
 * caller refresh its scoped data; it never replays edits or keeps a room warm.
 */
export function useCueSheetSync(options: Options) {
  const { orgId } = options;
  const handlers = useRef(options);
  handlers.current = options;
  const [connected, setConnected] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let refreshRetry: ReturnType<typeof setTimeout> | null = null;
    const refreshTimers = new Set<ReturnType<typeof setTimeout>>();
    const sequence = new RelaySequenceTracker();
    setConnected(false); setSyncError(null);

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${window.location.host}/api/cue-sheet/${encodeURIComponent(orgId)}/ws`);
      wsRef.current = socket;
      let hydrateTimeout: ReturnType<typeof setTimeout> | undefined;
      let refreshing = false;
      let refreshAgain = false;
      let buffered: CueSheetEvent[] = [];
      const current = () => !disposed && wsRef.current === socket;
      const deliver = (message: CueSheetEvent) => {
        if (message.type === "note") handlers.current.onNote(message);
        else if (message.type === "columns") handlers.current.onColumns();
        else handlers.current.onIncident?.(message);
      };
      const refresh = async () => {
        if (!current() || refreshing) return;
        refreshing = true; buffered = []; setConnected(false); setSyncError(null);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        if (refreshRetry) clearTimeout(refreshRetry);
        try {
          await Promise.race([
            handlers.current.onRefresh(),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Refresh timed out. Try again.")), 10_000); refreshTimers.add(timeout); }),
          ]);
          if (!current() || refreshAgain) return;
          for (const message of buffered) deliver(message);
          buffered = []; setConnected(true); setSyncError(null);
        } catch (error) {
          if (!current()) return;
          setSyncError(error instanceof Error ? error.message : "Could not refresh live changes. Try again.");
          refreshRetry = setTimeout(() => { void refresh(); }, 5000);
        } finally {
          refreshing = false;
          if (timeout) { clearTimeout(timeout); refreshTimers.delete(timeout); }
          if (current() && refreshAgain) { refreshAgain = false; void refresh(); }
        }
      };
      retryRef.current = () => { void refresh(); };
      const awaitHydrate = () => { clearTimeout(hydrateTimeout); hydrateTimeout = setTimeout(() => { if (current()) socket.close(); }, 5000); };
      socket.onopen = () => { if (current()) { attempts = 0; awaitHydrate(); } };
      socket.onmessage = event => {
        if (!current()) return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (message && typeof message === "object" && "type" in message && message.type === "hydrate") {
            clearTimeout(hydrateTimeout);
            sequence.snapshot(message);
            // Also closes the race between the route loader and WS admission.
            if (refreshing) refreshAgain = true;
            else void refresh();
            return;
          }
          const result = cueSheetEventSchema.safeParse(message);
          if (!result.success) return;
          const decision = sequence.delta(message);
          if (decision === "refresh") {
            setConnected(false); awaitHydrate();
            socket.send(JSON.stringify({ type: "sync", lastSeenSequence: sequence.lastSeenSequence }));
          }
          if (decision !== "apply") return;
          if (refreshing) {
            buffered.push(result.data);
            if (buffered.length > 1000) socket.close(); // Rehydrate instead of retaining an unbounded backlog.
          } else deliver(result.data);
        } catch { socket.close(); }
      };
      socket.onclose = () => {
        clearTimeout(hydrateTimeout);
        if (!current()) return;
        sequence.disconnect(); setConnected(false); wsRef.current = null;
        if (refreshRetry) clearTimeout(refreshRetry);
        reconnect = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15000));
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      disposed = true;
      if (reconnect) clearTimeout(reconnect);
      if (refreshRetry) clearTimeout(refreshRetry);
      for (const timer of refreshTimers) clearTimeout(timer);
      wsRef.current?.close(); wsRef.current = null;
      retryRef.current = () => {};
    };
  }, [orgId]);

  // This notification is published only after the mutation commits to D1.
  const publish = useCallback((event: CueSheetEvent) => {
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  }, []);
  const retrySync = useCallback(() => retryRef.current(), []);
  return { connected, publish, syncError, retrySync };
}
