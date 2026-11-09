import {
  EquipmentRequestError,
  type EquipmentController,
} from "@/hooks/useEquipmentCommands";

export function EquipmentRecovery({
  control,
}: {
  control: EquipmentController;
}) {
  const current = control.current,
    outcome = current?.result?.outcome;
  const action =
    "min-h-11 min-w-11 rounded-lg border border-board-border px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50";
  return (
    <div className="space-y-3">
      {control.validationError && (
        <p role="alert" className="text-sm text-red-300">
          {control.validationError}
        </p>
      )}
      {control.read.isError && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
        >
          <p>{control.read.error?.message ?? "Inventory could not refresh."}</p>
          <p>
            Last confirmed assets are shown. Changes are locked until you retry.
          </p>
          {control.read.error instanceof EquipmentRequestError && (
            <p className="mt-1 text-xs">
              Failed at{" "}
              {new Date(control.read.error.occurredAt).toLocaleTimeString()}
            </p>
          )}
          <button
            type="button"
            className={action}
            disabled={control.read.isFetching}
            onClick={() => void control.read.refetch()}
          >
            {control.read.isFetching
              ? "Refreshing inventory…"
              : "Retry inventory"}
          </button>
        </div>
      )}
      {current?.attempt && (
        <section
          aria-label="Asset change status"
          className="rounded-xl border border-board-border bg-board-bg p-3 text-sm text-board-text"
        >
          <p className="font-semibold">{current.attempt.label}</p>
          {control.pending ? (
            <p role="status">
              {current.attempt.mode === "review"
                ? "Checking the original request…"
                : "Waiting for confirmation…"}
            </p>
          ) : current.status === "error" ? (
            <>
              <p role="alert">
                {current.error instanceof Error
                  ? current.error.message
                  : "The change was not confirmed."}
              </p>
              <p>
                Your draft is kept. Retry checks for a saved result. Review
                cancels the change if it has not been applied.
              </p>
              {current.error instanceof EquipmentRequestError && (
                <p className="mt-1 text-xs">
                  Failed at{" "}
                  {new Date(current.error.occurredAt).toLocaleTimeString()}
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={action}
                  onClick={() => void control.recover()}
                >
                  Retry asset change
                </button>
                <button
                  type="button"
                  className={action}
                  onClick={() => void control.recover("review")}
                >
                  Review asset result
                </button>
              </div>
            </>
          ) : outcome === "applied" ? (
            <p role="status">
              Change confirmed.
              {control.read.isFetching ? " Refreshing inventory…" : ""}
            </p>
          ) : outcome ? (
            <>
              <p role="alert">
                {outcome === "conflict"
                  ? "The asset changed or was removed. Your change was not applied; your draft is retained."
                  : outcome === "expired"
                    ? "The request expired without applying your change. Your draft is retained."
                    : "The undelivered request was cancelled. Your draft is retained."}
              </p>
              {current.attempt.command.operation.kind === "update" && (
                <dl className="mt-2 space-y-1 break-words">
                  {Object.entries(
                    current.attempt.command.operation.updates,
                  ).map(([field, value]) => (
                    <div key={field}>
                      <dt className="font-medium">{field}</dt>
                      <dd className="whitespace-pre-wrap">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <button
                type="button"
                className={`${action} mt-2`}
                disabled={control.unavailable}
                onClick={control.dismiss}
              >
                Continue with current inventory
              </button>
            </>
          ) : null}
        </section>
      )}
    </div>
  );
}
