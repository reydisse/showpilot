import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Play,
  RotateCcw,
  TimerReset,
} from "lucide-react";
import { useTmRundown } from "@/hooks/useTmRundown";
import { useShowEndConfirmation } from "@/hooks/useShowEndConfirmation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
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
    detail: "Confirm before stopping",
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
    detail: "Confirm before hiding lyrics",
    icon: Captions,
  },
];
const outcomes = {
  applied: "Command confirmed.",
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
  return (
    <section
      aria-label="Rundown controls"
      className="min-w-0 rounded-xl border border-board-border bg-board-card overflow-hidden"
    >
      {endShowDialog}
      <ConfirmDialog
        open={lyricsScopeMatches}
        onOpenChange={(open) => {
          if (!open) setLyricsReview(null);
        }}
        title="Hide lyrics from displays?"
        description="This removes the current ProPresenter lyrics from connected ShowPilot displays. You can turn lyrics on again when ready."
        confirmLabel="Hide lyrics"
        confirmDisabled={!!disabledReason}
        onConfirm={() => {
          if (lyricsReview && lyricsScopeMatches)
            send("lyrics-off", lyricsReview);
          setLyricsReview(null);
        }}
      />
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-board-border p-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-board-text">
            Rundown controls
          </h2>
          <p className="break-words text-sm text-board-muted">
            {state?.currentItem?.title ??
              (state ? "No active item" : "Waiting for rundown feedback")}
          </p>
        </div>
        <span className="text-sm text-board-muted">
          {read.isError || stale
            ? "Last confirmed state"
            : state
              ? state.timer.playback === "play"
                ? "Running"
                : state.timer.playback === "pause"
                  ? "Paused"
                  : "Stopped"
              : "Not confirmed"}
        </span>
        <p className="basis-full text-xs text-board-muted">
          {read.dataUpdatedAt
            ? `Checked ${new Date(read.dataUpdatedAt).toLocaleTimeString()}`
            : "No confirmed check"}
        </p>
      </header>
      <ReadFailureNotice
        error={
          readFailure
            ? {
                message:
                  read.error?.message ?? "Rundown feedback is unavailable.",
                occurredAt: read.errorUpdatedAt,
              }
            : null
        }
        refreshing={read.isFetching}
        retry={() => void read.refetch()}
        label="Retry rundown feedback"
      />
      {disabledReason && !readFailure ? (
        <p role="status" className="px-4 pt-3 text-sm text-amber-200">
          {disabledReason}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
        {controls.map(({ action, label, detail, icon: Icon }) => {
          const inactive =
            !!disabledReason ||
            (action === "timer-start" &&
              (state?.timer.playback === "play" ||
                (!state?.currentItem && !state?.firstItem))) ||
            (action === "timer-stop" && state?.timer.playback === "stop") ||
            (action === "rundown-previous" && !state?.hasPrevious) ||
            ((action === "timer-add" || action === "timer-subtract") &&
              state?.timer.playback === "stop") ||
            (action === "rundown-next" &&
              !state?.nextItem &&
              state?.timer.playback === "stop") ||
            (action === "lyrics-on" && state?.lyricsEnabled) ||
            (action === "lyrics-off" && !state?.lyricsEnabled);
          const resume =
            action === "timer-start" && state?.timer.playback === "pause";
          return (
            <button
              key={action}
              type="button"
              disabled={inactive}
              onClick={() => run(action)}
              className="min-h-24 rounded-lg border border-board-border bg-board-bg/40 p-3 text-left text-board-text hover:border-fire-500/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fire-400 disabled:opacity-50"
            >
              <Icon className="mb-2 size-4" />
              <span className="block text-sm font-medium">
                {resume ? "Resume timer" : label}
              </span>{" "}
              <span className="mt-1 block text-xs text-board-muted">
                {resume ? "Continue the paused item" : detail}
              </span>
            </button>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-board-border p-4 text-sm">
        <p className="text-board-muted">
          Next: {state?.nextItem?.title ?? "—"} · Lyrics:{" "}
          {state ? (state.lyricsEnabled ? "On" : "Off") : "Not confirmed"}
        </p>
        <div aria-live="polite">
          {control.pending ? (
            "Sending command…"
          ) : control.latest?.status === "error" ? (
            <div role="alert" className="text-amber-200">
              <p>
                {control.latest.error instanceof Error
                  ? control.latest.error.message
                  : "Command was not confirmed."}{" "}
                Checked {new Date(control.latest.at).toLocaleTimeString()}
              </p>
              <button
                type="button"
                className="mt-2 min-h-11 rounded-lg border px-3"
                onClick={control.retry}
              >
                Retry rundown command
              </button>
            </div>
          ) : control.latest?.result ? (
            <p role="status" className="text-board-text">
              {outcomes[control.latest.result.outcome]}
            </p>
          ) : null}
        </div>
        <Link
          to="/$slug/rundown"
          params={{ slug }}
          className="inline-flex min-h-11 items-center text-fire-400 underline"
        >
          Open rundown
        </Link>
      </div>
    </section>
  );
}
