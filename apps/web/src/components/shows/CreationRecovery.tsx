import type { ShowCreationWork } from "@/hooks/useShowCreation";
const button =
  "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm text-board-text hover:bg-board-border disabled:opacity-50";
export function CreationRecovery<D>({ work }: { work: ShowCreationWork<D> }) {
  const attempt = work.attempt;
  return (
    <div className="space-y-2 text-sm break-words" aria-live="polite">
      {work.notice && (
        <p role="status" className="text-board-muted">
          {work.notice}
        </p>
      )}
      {attempt?.kind === "creating" && (
        <p role="status">
          Creating show… You can close this form and return to it.
        </p>
      )}
      {attempt?.kind === "reviewing" && (
        <p role="status">
          Checking the original request before allowing edits…
        </p>
      )}
      {attempt?.kind === "unconfirmed" && (
        <>
          <p role="alert" className="text-red-300">
            Creation is not confirmed. {attempt.message}
          </p>
          <p className="text-board-muted">
            Retry keeps the original request. Edit request checks for an
            existing show and stops a pending creation before unlocking the
            form.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} onClick={work.retry}>
              Retry creation
            </button>
            <button type="button" className={button} onClick={work.review}>
              Edit request
            </button>
          </div>
        </>
      )}
      {attempt?.kind === "created" && (
        <>
          <p role="status">Show created.</p>
          {attempt.opening === "failed" && (
            <p role="alert" className="text-red-300">
              Opening the show did not finish. {attempt.message} Retry opening;
              the show will not be created again.
            </p>
          )}
          <button
            type="button"
            className={button}
            disabled={attempt.opening === "pending"}
            onClick={work.open}
          >
            {attempt.opening === "pending"
              ? "Opening show…"
              : attempt.opening === "failed"
                ? "Retry opening show"
                : "Open show"}
          </button>
          <button
            type="button"
            className={button}
            disabled={attempt.opening === "pending"}
            onClick={work.another}
          >
            Create another show
          </button>
        </>
      )}
    </div>
  );
}
