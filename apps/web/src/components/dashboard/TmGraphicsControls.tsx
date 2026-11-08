import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTmGraphics } from "@/hooks/useTmGraphics";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import type { GraphicsClearSnapshot } from "@/lib/graphics-clear-contract";
export function TmGraphicsControls(props: {
  orgId: string;
  userId: string;
  slug: string;
}) {
  return <GraphicsControls key={`${props.orgId}:${props.userId}`} {...props} />;
}
function GraphicsControls({
  orgId,
  userId,
  slug,
}: {
  orgId: string;
  userId: string;
  slug: string;
}) {
  const control = useTmGraphics(orgId, userId),
    { read } = control,
    state = read.data;
  const [review, setReview] = useState<GraphicsClearSnapshot | null>(null),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const stale = !!read.dataUpdatedAt && now - read.dataUpdatedAt > 8_000,
    readFailure =
      read.isError ||
      (read.isFetching && read.errorUpdatedAt > read.dataUpdatedAt),
    hasOutput =
      !!state &&
      (!!state.program.length ||
        state.programUnknown ||
        !!state.lowerThirds.length),
    disabled =
      !state?.canClear ||
      !hasOutput ||
      readFailure ||
      stale ||
      !!control.unfinished;
  const result = control.latest?.result,
    outcome = !result
      ? null
      : result.program === "conflict"
        ? "Graphics changed after confirmation. Review current output before clearing again."
        : result.program === "expired"
          ? "Clear expired before changing output. Review current graphics before trying again."
          : result.relay === "conflict"
            ? "Program cleared. A newer lower third was preserved. Review current output before clearing again."
            : result.relay === "expired"
              ? "Program cleared, but the lower-third clear expired. Review current output before trying again."
              : "Clear request confirmed. Current graphics are shown above.";
  return (
    <section
      aria-label="Graphics controls"
      className="min-w-0 overflow-hidden rounded-xl border border-board-border bg-board-card"
    >
      <ConfirmDialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        title="Clear graphics from outputs?"
        confirmLabel="Clear graphics now"
        description={`Remove on-air graphics and lower thirds from connected ShowPilot outputs${review ? `: ${[...review.program.map((graphic) => graphic.title), ...review.lowerThirds, ...(review.programUnknown ? ["unrecognized saved output"] : [])].join(", ")}` : ""}. Saved graphics and scenes remain available.`}
        confirmDisabled={disabled}
        onConfirm={() => {
          if (review && state && !disabled)
            control.send({
              orgId,
              requestId: crypto.randomUUID(),
              expectedProgramRevision: review.programRevision,
              expectedRelayRevision: review.relayRevision,
              expiresAt: Math.floor(
                state.serverTime +
                  Math.max(0, Date.now() - read.dataUpdatedAt) +
                  5_000,
              ),
            });
          setReview(null);
        }}
      />
      <header className="space-y-1 border-b border-board-border p-4">
        <h2 className="text-base font-semibold text-board-text">
          Graphics controls
        </h2>
        <p className="text-sm text-board-muted">
          On-air graphics and lower thirds
        </p>
        <p className="text-xs text-board-muted">
          {read.dataUpdatedAt
            ? `${readFailure || stale ? "Last confirmed check" : "Checked"} ${new Date(read.dataUpdatedAt).toLocaleTimeString()}`
            : "No confirmed check"}
        </p>
      </header>
      <ReadFailureNotice
        error={
          readFailure
            ? {
                message:
                  read.error?.message ?? "Graphics feedback is unavailable.",
                occurredAt: read.errorUpdatedAt,
              }
            : null
        }
        refreshing={read.isFetching}
        retry={() => void read.refetch()}
        label="Retry graphics feedback"
      />
      <div className="space-y-3 p-4 text-sm text-board-text">
        {!state && !readFailure ? (
          <p role="status" className="text-board-muted">
            Checking graphics output…
          </p>
        ) : null}
        {state ? (
          <>
            <div className="space-y-1">
              <h3 className="font-medium">Program graphics</h3>
              {state.program.map((graphic) => (
                <p key={graphic.id} className="break-words">
                  {graphic.title}
                </p>
              ))}
              {state.programUnknown ? (
                <p className="text-amber-200">
                  Saved output could not be fully read. Confirm Clear to remove
                  it.
                </p>
              ) : !state.program.length ? (
                <p className="text-board-muted">No Program graphics on air</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <h3 className="font-medium">Lower thirds</h3>
              {state.lowerThirds.length ? (
                state.lowerThirds.map((title) => (
                  <p key={title} className="break-words">
                    {title}
                  </p>
                ))
              ) : (
                <p className="text-board-muted">No lower third on air</p>
              )}
            </div>
            {!state.canClear ? (
              <p className="text-amber-200">
                Graphics control permission is required.
              </p>
            ) : null}
          </>
        ) : null}
        {stale && !readFailure ? (
          <button
            type="button"
            disabled={read.isFetching}
            onClick={() => void read.refetch()}
            className="min-h-11 rounded-lg border px-3 text-amber-200"
          >
            {read.isFetching
              ? "Checking graphics feedback…"
              : "Refresh graphics feedback"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setReview(state ?? null)}
          className="min-h-11 rounded-lg border border-red-500/40 px-4 text-red-300 focus-visible:outline-2 disabled:opacity-50"
        >
          Clear graphics
        </button>
        <div aria-live="polite" className="space-y-2">
          {control.pending ? (
            <p>Clearing reviewed graphics…</p>
          ) : control.latest?.status === "error" ? (
            <div role="alert" className="text-amber-200">
              <p>
                {control.latest.error instanceof Error
                  ? control.latest.error.message
                  : "Clear was not confirmed."}{" "}
                Checked {new Date(control.latest.at).toLocaleTimeString()}
              </p>
              <button
                type="button"
                onClick={control.retry}
                className="mt-2 min-h-11 rounded-lg border px-3"
              >
                Retry graphics clear
              </button>
            </div>
          ) : outcome ? (
            <p role="status">{outcome}</p>
          ) : null}
        </div>
        <Link
          to="/$slug/streaming/graphics"
          params={{ slug }}
          className="inline-flex min-h-11 items-center text-fire-400 underline"
        >
          Open Graphics
        </Link>
      </div>
    </section>
  );
}
