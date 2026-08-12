/**
 * Live fan-out for the cue sheet.
 *
 * The socket is a courier, not a source of truth. Every edit is written
 * to D1 by a permission-checked server function first; this only tells
 * the other tabs so they don't have to reload. If it never connects the
 * sheet still works — you just stop seeing other people type.
 *
 * Reconnect backs off and caps, matching the rundown sync hook, because
 * a church on 5Mbps will drop this socket several times during a service
 * and a tight retry loop is worse than the disconnection.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface CueNoteEvent {
  type: "note";
  serviceDate: string;
  itemId: string;
  columnId: string;
  text: string;
  by: string;
  at: number;
}

export interface CueColumnsEvent {
  type: "columns";
  at: number;
}

export type CueSheetEvent = CueNoteEvent | CueColumnsEvent;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** DOs hibernate on an idle socket; this keeps the room warm. */
const PING_MS = 20000;

interface Options {
  orgId: string;
  onNote: (event: CueNoteEvent) => void;
  onColumns: () => void;
}

export function useCueSheetSync({ orgId, onNote, onColumns }: Options) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const attempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const closing = useRef(false);

  // Handlers are held in refs so a parent re-render doesn't tear the
  // socket down and reconnect on every keystroke.
  const onNoteRef = useRef(onNote);
  const onColumnsRef = useRef(onColumns);
  useEffect(() => {
    onNoteRef.current = onNote;
    onColumnsRef.current = onColumns;
  }, [onNote, onColumns]);

  const connect = useCallback(() => {
    if (typeof window === "undefined") return;
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${protocol}://${window.location.host}/api/cue-sheet/${orgId}/ws`,
    );
    wsRef.current = ws;

    ws.onopen = () => {
      closing.current = false;
      attempts.current = 0;
      setConnected(true);
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, PING_MS);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as CueSheetEvent;
        if (message.type === "note") onNoteRef.current(message);
        else if (message.type === "columns") onColumnsRef.current();
      } catch {
        // A malformed frame is not worth surfacing to an operator.
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (pingTimer.current) clearInterval(pingTimer.current);
      if (closing.current) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts.current, RECONNECT_MAX_MS);
      attempts.current += 1;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [orgId]);

  useEffect(() => {
    connect();
    return () => {
      closing.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  /** Tell the other tabs. Silently a no-op while disconnected. */
  const publish = useCallback((event: CueSheetEvent) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(event));
  }, []);

  return { connected, publish };
}
