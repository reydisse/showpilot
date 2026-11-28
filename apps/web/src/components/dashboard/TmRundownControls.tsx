import { QuietActivity } from "@/components/ui/QuietActivity";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Captions,
  CaptionsOff,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  TimerReset,
  TriangleAlert,
} from "lucide-react";
import { Callout, ControlTile, Spinner, TmPanel, tmLink, tmSecondary } from "./tm-a";
import { useTmRundown } from "@/hooks/useTmRundown";
import { useShowEndConfirmation } from "@/hooks/useShowEndConfirmation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  TmRundownAction,
  TmRundownSnapshot,
} from "@/lib/tm-rundown-contract";
const controls: Array<{
  action: TmRundownAction;
  label: string;
  detail: string;
  icon: typeof Play;
}> = [
  {
    action: "timer-start",
    label: "Start timer",
    detail: "Start the first available item",
    icon: Play,
  },
  {
    action: "timer-stop",
    label: "End show",
    detail: "Confirms before stopping",
    icon: CircleStop,
  },
  {
    action: "rundown-previous",
    label: "Previous",
    detail: "Previous rundown item",
    icon: ChevronLeft,
  },
  {
    action: "rundown-next",
    label: "Next",
    detail: "Advance rundown item",
    icon: ChevronRight,
  },
  {
    action: "timer-subtract",
    label: "−1 minute",
    detail: "Reduce remaining time",
    icon: RotateCcw,
  },
  {
    action: "timer-add",
    label: "+1 minute",
    detail: "Extend remaining time",
    icon: TimerReset,
  },
  {
    action: "lyrics-on",
    label: "Lyrics on",
    detail: "Show ProPresenter lyrics",
    icon: Captions,
  },
  {
    action: "lyrics-off",
    label: "Lyrics off",
    detail: "Confirms before hiding lyrics",
    icon: CaptionsOff,
  },
];
const outcomes = {
  applied: "",
  "revision-conflict":
    "The rundown changed before this command could be confirmed. Review the latest feedback before trying again.",
  expired:
    "The original command has expired. Review the current state before sending a new command.",
  "target-changed":
    "The active show changed. Review the current show before using its controls.",
  unavailable:
    "Open the rundown to prepare this show before using its controls.",
};
export function TmRundownControls({
  orgId,
  userId,
  slug,
}: {
  orgId: string;
  userId: string;
  slug: string;
}) {
  const control = useTmRundown(orgId, userId),
    { read } = control,
    state = read.data;
  const [now, setNow] = useState(Date.now),
    [lyricsReview, setLyricsReview] = useState<TmRundownSnapshot | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const stale = !!read.dataUpdatedAt && now - read.dataUpdatedAt > 8_000;
  const disabledReason = !state
    ? "Wait for current rundown feedback."
    : read.isError || stale
      ? "Refresh rundown feedback before sending a command."
      : control.unfinished
        ? "Recover the previous command before sending another."
        : !state.initialized
          ? "Open the rundown to prepare this show."
          : !state.canControl
            ? (state.blockedReason ?? "Rundown control permission is required.")
            : undefined;
  const send = (action: TmRundownAction, review = state) => {
    if (disabledReason || !review) return;
    control.send({
      orgId,
      requestId: crypto.randomUUID(),
      action,
      target: review.target,
      expectedRevision: review.revision,
      expiresAt: Math.floor(
        review.serverTime +
          Math.max(0, Date.now() - read.dataUpdatedAt) +
          5_000,
      ),
    });
  };
  const { requestEndShow, endShowDialog } = useShowEndConfirmation(
    {
      orgId,
      showId: state?.target.showId,
      serviceDate: state?.target.serviceDate ?? "",
    },
    () => send("timer-stop"),
    disabledReason ??
      (state?.timer.playback === "stop"
        ? "This show is already stopped."
        : undefined),
  );
  const lyricsScopeMatches =
    !!lyricsReview &&
    !!state &&
    lyricsReview.target.showId === state.target.showId &&
    lyricsReview.target.serviceDate === state.target.serviceDate;
  useEffect(() => {
    if (lyricsReview && !lyricsScopeMatches) setLyricsReview(null);
  }, [lyricsReview, lyricsScopeMatches]);
  const run = (action: TmRundownAction) => {
    if (disabledReason) return;
    if (
      action === "timer-stop" ||
      (action === "rundown-next" && !state?.nextItem)
    ) {
      requestEndShow();
      return;
    }
    if (action === "lyrics-off") {
      setLyricsReview(state ?? null);
      return;
    }
    send(action);
  };
  const readFailure =
    read.isError ||
    (read.isFetching && read.errorUpdatedAt > read.dataUpdatedAt);
  const playback = state?.timer.playback;
  // One short reason under every tile that cannot act right now.
  const blanket = readFailure ? "Paused" : stale ? "Out of date" : control.unfinished ? "Waiting for the last command" : state && !state.initialized ? "Rundown not prepared" : state && !state.canControl ? "Locked" : !state ? "Waiting" : null;
  const tileState = (action: TmRundownAction): { disabled: boolean; detail?: string } => {
    if (disabledReason) return { disabled: true, detail: blanket ?? undefined };
    switch (action) {
      case "timer-start": return playback === "play" ? { disabled: true, detail: "Already playing" } : !state?.currentItem && !state?.firstItem ? { disabled: true, detail: "No item to start" } : { disabled: false };
      case "timer-stop": return { disabled: playback === "stop" };
      case "rundown-previous": return state?.hasPrevious ? { disabled: false } : { disabled: true, detail: "No previous item" };
      case "timer-add":
      case "timer-subtract": return playback === "stop" ? { disabled: true, detail: "Stopped" } : { disabled: false };
      case "rundown-next": return !state?.nextItem && playback === "stop" ? { disabled: true, detail: "No next item" } : { disabled: false };
      case "lyrics-on": return state?.lyricsEnabled ? { disabled: true, detail: "Lyrics are on" } : { disabled: false };
      case "lyrics-off": return !state?.lyricsEnabled ? { disabled: true, detail: "Already off" } : { disabled: false };
    }
  };
  const pill = readFailure || stale || !state ? null : playback === "play"
    ? <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--sa-ok)]/40 bg-[var(--sa-ok)]/10 px-2.5 text-xs font-medium text-[var(--sa-ok)]"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--sa-ok)]" />Playing</span>
    : <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--sa-border-strong)] px-2.5 text-xs font-medium text-[var(--sa-ink-2)]"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full shadow-[inset_0_0_0_1.5px_currentColor]" />{playback === "pause" ? "Paused" : "Stopped"}</span>;
  return (
    <TmPanel
      icon={Play}
      title="Rundown controls"
      label="Rundown controls"
      action={pill}
      footer={<>
        <p className="min-w-0 flex-1 text-[13px] text-[var(--sa-ink-2)]">
          Next: {state?.nextItem?.title ?? "—"} · Lyrics:{" "}
          {state ? (state.lyricsEnabled ? "On" : "Off") : "—"}
        </p>
        <Link to="/$slug/rundown" params={{ slug }} className={tmLink}>Open rundown</Link>
      </>}
    >
      {endShowDialog}
      <ConfirmDialog
        open={lyricsScopeMatches}
        onOpenChange={(open) => {
          if (!open) setLyricsReview(null);
        }}
        title="Hide lyrics from displays?"
        description="ProPresenter lyrics stop showing on connected ShowPilot displays. You can turn lyrics on again when ready."
        confirmLabel="Hide lyrics"
        confirmDisabled={!!disabledReason}
        onConfirm={() => {
          if (lyricsReview && lyricsScopeMatches)
            send("lyrics-off", lyricsReview);
          setLyricsReview(null);
        }}
      />
      <div className="flex flex-col gap-3">
        {state?.currentItem && playback !== "stop" ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--sa-ink-3)]">Now running</p>
            <p className="break-words text-[15px] font-semibold text-board-text">{state.currentItem.title}</p>
          </div>
        ) : (
          <p className="break-words text-[13px] text-[var(--sa-ink-2)]">
            {state?.currentItem?.title ?? (state ? "No active item" : <QuietActivity label="Waiting for rundown feedback" />)}
          </p>
        )}
        {readFailure ? (
          <Callout tone="warn" icon={TriangleAlert} role="alert" title="Couldn't load rundown status"
            action={<button type="button" disabled={read.isFetching} onClick={() => void read.refetch()} className={tmSecondary} aria-label="Retry rundown feedback">
              <RefreshCw className={`h-3.5 w-3.5 ${read.isFetching ? "animate-spin motion-reduce:animate-none" : ""}`} />{read.isFetching ? "Retrying…" : "Retry rundown feedback"}
            </button>}>
            Controls are paused. We'll keep trying.
          </Callout>
        ) : disabledReason && stale ? (
          <Callout tone="warn" icon={TriangleAlert} role="status" title="Rundown status is out of date">Controls are off until a fresh read arrives.</Callout>
        ) : disabledReason && state && !state.canControl ? (
          <Callout tone="muted" icon={Lock} role="status" title={disabledReason} />
        ) : disabledReason ? (
          <p role="status" className="text-[13px] text-[var(--sa-warn)]">{disabledReason}</p>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {controls.map(({ action, label, detail, icon }) => {
            const tile = tileState(action);
            const resume = action === "timer-start" && playback === "pause";
            return (
              <ControlTile
                key={action}
                icon={icon}
                label={resume ? "Resume timer" : label}
                detail={resume && !tile.disabled ? "Timer is paused" : tile.detail ?? detail}
                disabled={tile.disabled}
                danger={action === "timer-stop" && playback !== "stop"}
                onClick={() => run(action)}
              />
            );
          })}
        </div>
        <div aria-live="polite" className="empty:hidden">
          {control.pending ? (
            <p className="inline-flex items-center gap-2 text-[13px] text-[var(--sa-ink-2)]"><Spinner /><QuietActivity label="Sending command…" /></p>
          ) : control.latest?.status === "error" ? (
            <Callout tone="danger" icon={TriangleAlert} role="alert" title="This rundown change needs attention."
              action={<button type="button" className={tmSecondary} onClick={control.retry}><RefreshCw className="h-3.5 w-3.5" />Retry rundown command</button>} />
          ) : control.latest?.result && outcomes[control.latest.result.outcome] ? (
            <p role="status" className="text-[13px] text-board-text">
              {outcomes[control.latest.result.outcome]}
            </p>
          ) : null}
        </div>
      </div>
    </TmPanel>
  );
}
