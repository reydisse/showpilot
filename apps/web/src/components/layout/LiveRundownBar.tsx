import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Pause, Play, Radio } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useRundownSync } from "@/hooks/useRundownSync";
import { useShowEndConfirmation } from "@/hooks/useShowEndConfirmation";
import { nextPlayableItem } from "@/lib/rundown-transport";
import { getActiveRundownTarget } from "@/lib/rundown";
import { withOperationTimeout } from "@/lib/operation-timeout";

export const ACTIVE_RUNDOWN_CHANGED_EVENT = "showpilot:active-rundown-changed";

interface LiveRundownBarProps {
  orgId: string;
  slug: string;
  canControl: boolean;
}
interface ActiveTarget { serviceDate: string; showId?: string }
type TargetLookup = { status: "loading" } | { status: "ready"; target: ActiveTarget } | { status: "unavailable"; target?: ActiveTarget };

function formatTimer(milliseconds: number): string {
  const sign = milliseconds < 0 ? "-" : "";
  const seconds = Math.floor(Math.abs(milliseconds) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${sign}${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${sign}${minutes}:${String(remainder).padStart(2, "0")}`;
}

function Bar({ children }: { children: ReactNode }) {
  return <section aria-label="Live rundown" className="relative z-30 shrink-0 border-b border-fire-500/25 bg-[#15130f] px-3 py-2 text-board-text shadow-[0_6px_24px_rgba(0,0,0,0.2)] sm:px-4">{children}</section>;
}

function ActiveRundownSession({ target, orgId, slug, canControl, targetFresh, refresh }: LiveRundownBarProps & { target: ActiveTarget; targetFresh: boolean; refresh: ReactNode }) {
  const { items, timer, serviceName, connected, hydrated, sendCommand, lastError, lastErrorAt, retryConnection } = useRundownSync(orgId, target.serviceDate, target.showId);
  const [now, setNow] = useState(Date.now());
  const [hasRun, setHasRun] = useState(false);
  const live = connected && hydrated && targetFresh;
  const currentItem = items.find(item => item.id === timer.currentItemId);
  const active = timer.playback !== "stop";
  const disabledReason = !live ? "Reconnect to live state before ending this show." : !canControl ? "Control access is required." : !active || !currentItem ? "The show is no longer running." : undefined;
  const { requestEndShow, endShowDialog } = useShowEndConfirmation(
    { orgId, ...target }, () => sendCommand("timer-stop"), disabledReason,
  );

  useEffect(() => {
    if (hydrated && active) setHasRun(true);
  }, [hydrated, active]);
  useEffect(() => {
    if (!live || timer.playback !== "play") return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [live, timer.playback]);

  const clockNow = Math.max(now, timer.serverTime ?? now);
  const elapsed = timer.elapsed + (timer.playback === "play" && timer.startedAt !== null ? clockNow - timer.startedAt : 0);
  const displayed = timer.mode === "count-down" ? (currentItem?.duration ?? 0) - elapsed : elapsed;
  const isPaused = timer.playback === "pause";
  const title = !hydrated ? "Connecting to rundown…" : !active ? hasRun ? "Show ended" : "No live rundown" : !currentItem ? "Live item unavailable" : isPaused ? "Rundown paused" : "Rundown live";
  const connectionNotice = !live ? hydrated ? "Reconnecting, showing last known state" : "Waiting for confirmed live state" : null;

  return <Bar>
    {endShowDialog}
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <Radio aria-hidden="true" className={`h-4 w-4 shrink-0 ${live && active ? "text-fire-400" : "text-board-muted"}`} />
      <Link to="/$slug/rundown" params={{ slug }} search={{ date: target.serviceDate, show: target.showId }}
        className="min-w-0 flex-1 rounded py-1 focus-visible:outline-2 focus-visible:outline-fire-500 focus-visible:outline-offset-2">
        <p className="text-xs font-semibold text-fire-400" role="status" aria-live="polite">{title}</p>
        {hydrated && <p className="truncate text-sm" title={currentItem && active ? currentItem.title : serviceName || target.serviceDate}>
          {currentItem && active ? currentItem.title : serviceName || target.serviceDate}
        </p>}
      </Link>
      {hydrated && active && currentItem && <span data-live-rundown-timer className={`shrink-0 font-mono text-base font-bold tabular-nums ${displayed < 0 ? "text-red-400" : "text-board-text"}`}>{formatTimer(displayed)}</span>}
      {hydrated && active && currentItem && canControl && <div className="flex basis-full justify-end gap-1 sm:basis-auto">
        <Button type="button" variant="ghost" size="icon" aria-label="Previous rundown item" disabled={!live} onClick={() => sendCommand("timer-prev")} className="h-11 w-11"><ChevronLeft /></Button>
        <Button type="button" size="icon" aria-label={isPaused ? "Resume rundown" : "Pause rundown"} disabled={!live} onClick={() => sendCommand(isPaused ? "timer-resume" : "timer-pause")} className="h-11 w-11">{isPaused ? <Play className="fill-current" /> : <Pause className="fill-current" />}</Button>
        <Button type="button" variant="ghost" size="icon" aria-label="Next rundown item" disabled={!live} className="h-11 w-11"
          onClick={() => { if (!nextPlayableItem(items, timer.currentItemId)) requestEndShow(); else sendCommand("timer-next"); }}><ChevronRight /></Button>
      </div>}
    </div>
    {connectionNotice && <p role="status" aria-live="polite" className="mt-1 text-xs text-amber-200">{connectionNotice}</p>}
    {lastError && <p role="alert" className="mt-1 break-words text-xs text-red-300">{lastError} {lastErrorAt != null && <time dateTime={new Date(lastErrorAt).toISOString()}>{new Date(lastErrorAt).toLocaleTimeString()}</time>}</p>}
    {!connected && lastError && <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={retryConnection}>Reconnect rundown</Button>}
    {refresh}
  </Bar>;
}

function LiveRundownWorkspace(props: LiveRundownBarProps) {
  const [lookup, setLookup] = useState<TargetLookup>({ status: "loading" });
  const [refreshPending, setRefreshPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      setRefreshPending(true);
      try {
        const target = await withOperationTimeout(getActiveRundownTarget({ data: { orgId: props.orgId } }), 10_000, "Live rundown lookup timed out.");
        if (!disposed) setLookup({ status: "ready", target });
      } catch {
        if (!disposed) setLookup(previous => ({ status: "unavailable", target: "target" in previous ? previous.target : undefined }));
      } finally {
        refreshing = false;
        if (!disposed) setRefreshPending(false);
      }
    };
    void refresh();
    const refreshWhileVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = window.setInterval(refreshWhileVisible, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhileVisible);
    window.addEventListener(ACTIVE_RUNDOWN_CHANGED_EVENT, refresh);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhileVisible);
      window.removeEventListener(ACTIVE_RUNDOWN_CHANGED_EVENT, refresh);
    };
  }, [props.orgId, attempt]);

  const retry = lookup.status === "unavailable" ? <Button type="button" variant="outline" className="mt-2 min-h-11 text-xs" disabled={refreshPending} onClick={() => setAttempt(value => value + 1)}>{refreshPending ? "Checking live rundown…" : "Retry live rundown"}</Button> : null;
  const target = "target" in lookup ? lookup.target : undefined;
  return target ? <ActiveRundownSession key={JSON.stringify([target.showId ?? null, target.serviceDate])} {...props} target={target} targetFresh={lookup.status === "ready"} refresh={retry} />
    : <Bar><p role="status" aria-live="polite" className="text-xs text-board-text">{lookup.status === "loading" ? "Checking live rundown…" : "Live rundown unavailable"}</p>{retry}</Bar>;
}

/** Replacing the workspace clears its target, timer and pending confirmation synchronously. */
export function LiveRundownBar(props: LiveRundownBarProps) {
  return <LiveRundownWorkspace key={props.orgId} {...props} />;
}
