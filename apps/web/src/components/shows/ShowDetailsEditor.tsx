import type { ReactNode } from "react";
import { useShowDetails, type ShowDetailsDraft } from "@/hooks/useShowDetails";
import { formatTimeInput } from "@/lib/utils";

const inputClass =
  "min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text outline-none focus:border-fire-500 disabled:opacity-60";
const buttonClass =
  "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm font-semibold disabled:opacity-50";
export function ShowDetailsEditor({
  scope,
  initialDraft,
  nameLabel,
  callTimeNote,
  refresh,
  onRefreshed,
  disabled = false,
  children,
}: {
  scope: { orgId: string; userId: string; showId: string };
  initialDraft: ShowDetailsDraft;
  nameLabel: string;
  callTimeNote: string;
  refresh: (signal: AbortSignal) => Promise<void>;
  onRefreshed: () => void;
  disabled?: boolean;
  children?: (locked: boolean) => ReactNode;
}) {
  const work = useShowDetails(scope, initialDraft, { refresh, onRefreshed });
  const { draft, attempt } = work,
    locked = disabled || !!attempt;
  const settled = attempt?.kind === "settled" ? attempt : null;
  const snapshot = settled?.result.snapshot;
  const timezone = draft.timeZone ?? "UTC";
  return (
    <>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) void work.save();
        }}
      >
        <fieldset disabled={locked} className="min-w-0 space-y-4">
          <label className="block text-xs text-board-muted">
            {nameLabel}
            <input
              aria-label={nameLabel}
              className={`${inputClass} mt-1.5`}
              value={draft.name}
              maxLength={120}
              onChange={(event) =>
                work.changeDraft({ name: event.target.value })
              }
            />
          </label>
          <label className="block text-xs text-board-muted">
            Start time
            <input
              aria-label="Start time"
              type="time"
              className={`${inputClass} mt-1.5`}
              value={draft.startTime}
              onChange={(event) =>
                work.changeDraft({ startTime: event.target.value })
              }
            />
          </label>
          <label className="block text-xs text-board-muted">
            Crew call time
            <input
              aria-label="Crew call time"
              type="time"
              className={`${inputClass} mt-1.5`}
              value={draft.callTime}
              onChange={(event) =>
                work.changeDraft({ callTime: event.target.value })
              }
            />
          </label>
          <p className="text-xs leading-5 text-board-muted">
            Times use {timezone}.{" "}
            {draft.callTime
              ? "Clear the call time to use the organization default."
              : callTimeNote}
          </p>
          <label className="block text-xs text-board-muted">
            Venue or location
            <input
              aria-label="Venue or location"
              className={`${inputClass} mt-1.5`}
              value={draft.location}
              maxLength={240}
              onChange={(event) =>
                work.changeDraft({ location: event.target.value })
              }
            />
          </label>
        </fieldset>
        {work.notice ? (
          <p role="status" className="text-sm leading-5">
            {work.notice}
          </p>
        ) : null}
        {!attempt ? (
          <button
            disabled={disabled || !draft.name.trim()}
            className="min-h-11 w-full rounded-xl bg-fire-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
          >
            Save show details
          </button>
        ) : null}
        {attempt?.kind === "saving" || attempt?.kind === "reviewing" ? (
          <p role="status" className="text-sm leading-5">
            {attempt.kind === "saving"
              ? "Saving show details…"
              : "Reviewing the original save…"}{" "}
            You can close this form and return.
          </p>
        ) : null}
        {attempt?.kind === "unconfirmed" ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm leading-5 text-red-300">
              {attempt.message} Your draft and original save are retained.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={disabled}
                className={buttonClass}
                onClick={() => void work.retry()}
              >
                Retry original save
              </button>
              <button
                type="button"
                disabled={disabled}
                className={buttonClass}
                onClick={() => void work.review()}
              >
                Review save
              </button>
            </div>
            <p className="text-xs leading-5 text-board-muted">
              Review confirms whether the save succeeded. If it has not reached
              the show, review cancels that request before you edit again.
            </p>
          </div>
        ) : null}
        {settled ? (
          <div className="space-y-3">
            <p
              role={settled.result.outcome === "applied" ? "status" : "alert"}
              className="text-sm leading-5"
            >
              {settled.result.outcome === "applied"
                ? "Show details saved."
                : settled.result.outcome === "superseded"
                  ? "Your save succeeded. The show has newer changes; review the current details below."
                  : settled.result.outcome === "cancelled"
                    ? "The original save was cancelled. Review the current details before editing again."
                    : settled.result.outcome === "removed"
                      ? "This show was removed. The original request cannot recreate it."
                      : "These edits were not saved because the show changed. Review the current details below."}
            </p>
            {snapshot && settled.result.outcome !== "applied" ? (
              <div
                className="rounded-lg border border-board-border p-3 text-sm leading-6"
                aria-label="Current show details"
              >
                <p className="font-semibold">Current show details</p>
                <p className="break-words">
                  {snapshot.name || "Untitled show"}
                </p>
                <p>
                  {snapshot.serviceDate} · Start{" "}
                  {formatTimeInput(snapshot.scheduledStartTime, timezone) ||
                    "not set"}{" "}
                  · Call{" "}
                  {formatTimeInput(snapshot.scheduledCallTime, timezone) ||
                    "organization default"}
                </p>
                <p className="break-words">
                  {snapshot.location || "No location"}
                </p>
              </div>
            ) : null}
            {settled.message ? (
              <p role="alert" className="text-sm text-red-300">
                {settled.message} The save is confirmed; refreshing will not
                save again.
              </p>
            ) : null}
            {snapshot ? (
              <div className="flex flex-wrap gap-2">
                {settled.result.outcome === "applied" ||
                settled.result.outcome === "superseded" ? (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={disabled || settled.refresh === "pending"}
                    onClick={() => void work.refreshSaved()}
                  >
                    {settled.refresh === "pending"
                      ? "Refreshing…"
                      : "Refresh show"}
                  </button>
                ) : null}
                {settled.result.outcome !== "applied" ? (
                  <>
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={disabled || settled.refresh === "pending"}
                      onClick={() => work.editCurrent(true)}
                    >
                      Keep my edits
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={disabled || settled.refresh === "pending"}
                      onClick={() => work.editCurrent(false)}
                    >
                      Use current details
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
      {children?.(locked)}
    </>
  );
}
