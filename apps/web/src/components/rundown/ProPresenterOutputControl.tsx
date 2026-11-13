import { useState } from "react";
import { useProPresenterOutput } from "@/hooks/useProPresenterOutput";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type Props = Parameters<typeof useProPresenterOutput>[0];
export function ProPresenterOutputControl(props: Props) {
  return (
    <ScopedOutputControl
      key={`${props.orgId}:${props.userId}:${props.surface}`}
      {...props}
    />
  );
}
function ScopedOutputControl(props: Props) {
  const output = useProPresenterOutput(props);
  const [review, setReview] = useState<ReturnType<typeof output.prepare>>(null);
  const attempt = output.attempt;
  const buttonClass = "h-auto min-h-11 whitespace-normal";
  const resultText =
    attempt?.kind === "confirmed"
      ? {
          applied:
            "Output change saved. Connected stage displays apply the setting.",
          superseded:
            "Another operator changed the output after this request. The original change will not be repeated.",
          conflict:
            "Output changed after your review. Your change was not applied.",
          expired:
            "This change arrived too late and was not applied. Review the current output before another action.",
        }[attempt.result.outcome]
      : null;
  return (
    <section
      aria-label="ProPresenter stage output"
      className="my-3 space-y-3 rounded-xl border border-board-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-board-text">Stage display output</p>
          <p className="text-board-muted">
            {output.state.data
              ? `${output.state.isError ? "Last confirmed: " : ""}ProPresenter slides ${output.state.data.enabled ? "enabled" : "disabled"}.`
              : output.state.isError
                ? "Output state unavailable."
                : "Reading output state…"}
          </p>
          <p className="mt-1 text-xs text-board-muted">
            Shared across this workspace’s stage displays.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className={buttonClass}
          disabled={!output.canStart || !!review}
          onClick={() => setReview(output.prepare())}
        >
          {output.state.data?.enabled
            ? "Hide stage slides"
            : "Show stage slides"}
        </Button>
      </div>
      {review && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setReview(null);
          }}
          title={
            review.enabled
              ? "Show ProPresenter slides?"
              : "Hide ProPresenter slides?"
          }
          description={
            output.matches(review)
              ? "This changes ProPresenter lyrics and scripture on stage displays across this workspace."
              : "The output or your access changed during review. Cancel and review the current state."
          }
          confirmLabel={review.enabled ? "Show slides" : "Hide slides"}
          variant="warning"
          confirmDisabled={!output.matches(review)}
          onConfirm={() => output.confirm(review)}
        />
      )}
      {output.state.isError && (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            Output state could not refresh. Retry the read before changing it.{" "}
            <Timestamp at={output.state.errorUpdatedAt} />
          </p>
          <Button
            type="button"
            variant="outline"
            className={buttonClass}
            disabled={output.state.isFetching}
            onClick={() => void output.state.refetch()}
          >
            Retry output state
          </Button>
        </div>
      )}
      {attempt?.kind === "pending" && (
        <p role="status" className="text-sm text-board-muted">
          Waiting for output confirmation…
        </p>
      )}
      {attempt?.kind === "unknown" && (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            Output change was not confirmed. Recover the original request before
            changing it again. <Timestamp at={attempt.at} />
          </p>
          <Button
            type="button"
            variant="outline"
            className={buttonClass}
            disabled={!props.enabled}
            onClick={output.recover}
          >
            Recover output change
          </Button>
        </div>
      )}
      {attempt?.kind === "confirmed" && (
        <div
          role={
            attempt.result.outcome === "applied" && attempt.refresh === "done"
              ? "status"
              : "alert"
          }
          className="space-y-2 text-sm text-board-muted"
        >
          <p>
            {resultText} <Timestamp at={attempt.at} />
          </p>
          {attempt.refresh !== "done" && (
            <>
              <p>
                {attempt.refresh === "pending"
                  ? "Refreshing current output…"
                  : "Command result saved. Current output could not refresh. Retry the read."}
              </p>
              <Button
                type="button"
                variant="outline"
                className={buttonClass}
                disabled={!props.enabled || attempt.refresh === "pending"}
                onClick={output.refresh}
              >
                Refresh saved output result
              </Button>
            </>
          )}
          {attempt.refresh === "done" &&
            attempt.result.outcome !== "applied" && (
              <Button
                type="button"
                variant="outline"
                className={buttonClass}
                disabled={!props.enabled || output.state.isError}
                onClick={output.dismiss}
              >
                Review current output
              </Button>
            )}
        </div>
      )}
    </section>
  );
}
function Timestamp({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleTimeString()}
    </time>
  );
}
