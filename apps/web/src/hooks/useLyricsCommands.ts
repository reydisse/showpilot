import { useCallback, useEffect, useRef, useState } from "react";
import { requestLyricsControl, type LyricsOperation } from "@/lib/lyrics-control";
import type { LyricsDisplayState } from "@/types/timecode";

export function useLyricsCommands(options: {
  orgId: string;
  showId: string | null;
  lyrics: LyricsDisplayState | null;
  connected: boolean;
  canControl: boolean;
}) {
  const latest = useRef(options);
  latest.current = options;
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<LyricsOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { orgId, showId, connected, canControl } = options;
  useEffect(() => {
    setPending(null);
    setError(null);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [orgId, showId, connected, canControl]);

  const run = useCallback(async (operation: LyricsOperation) => {
    const current = latest.current;
    if (!current.connected || !current.showId) throw new Error("Reconnect to the selected show before changing lyrics.");
    if (!current.canControl) throw new Error("Take timecode control before changing lyrics.");
    if (!current.lyrics) throw new Error("Show a song section before changing lyrics.");
    if (request.current) throw new Error("Wait for the current lyrics change to finish.");
    const controller = new AbortController();
    request.current = controller;
    setPending(operation);
    setError(null);
    try {
      await requestLyricsControl({ ...current, showId: current.showId, lyrics: current.lyrics, operation, signal: controller.signal });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Lyrics change was not confirmed. Check the display before trying again.";
      if (request.current === controller && latest.current.orgId === current.orgId && latest.current.showId === current.showId) setError(message);
      throw new Error(message);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }, []);
  return { run, pending, error };
}
