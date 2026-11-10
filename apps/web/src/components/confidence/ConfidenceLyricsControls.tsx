import { useEffect, useState } from "react";
import { z } from "zod";
import { LyricsControls } from "@/components/timecode/LyricsControls";
import { useLyricsCommands } from "@/hooks/useLyricsCommands";
import type { LyricsDisplayState } from "@/types/timecode";

export function ConfidenceLyricsControls({ orgSlug, showId, lyrics, connected }: {
  orgSlug: string; showId: string; lyrics: LyricsDisplayState; connected: boolean;
}) {
  const [authority, setAuthority] = useState<boolean | null>(null);
  useEffect(() => {
    setAuthority(null);
    if (!connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/timecode/${encodeURIComponent(orgSlug)}/lyrics-controls?showId=${encodeURIComponent(showId)}`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]), cache: "no-store",
        });
        const result = response.ok ? z.object({ canControl: z.boolean() }).safeParse(await response.json()) : null;
        if (!controller.signal.aborted) setAuthority(result?.success ? result.data.canControl : null);
      } catch {
        if (!controller.signal.aborted) setAuthority(current => current === null ? null : false);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 5_000);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [orgSlug, showId, connected]);
  const controls = useLyricsCommands({ orgId: orgSlug, showId, lyrics, connected, canControl: authority === true });
  if (authority === null) return null;
  return <div className="shrink-0 border-t border-white/15 bg-board-bg p-3 text-board-text">
    <LyricsControls enabled={connected && authority} pending={controls.pending} error={controls.error} onChange={controls.run} />
    {!authority && <p className="mt-2 text-xs text-board-muted">Take control in <a className="underline" href={`/${encodeURIComponent(orgSlug)}/timecode`} target="_blank" rel="noreferrer">Timecode</a> to change lyrics from this display.</p>}
  </div>;
}
