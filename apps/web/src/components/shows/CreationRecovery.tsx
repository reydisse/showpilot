import { QuietActivity } from "@/components/ui/QuietActivity";
import type { ShowCreationWork } from "@/hooks/useShowCreation";
const button =
  "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm text-board-text hover:bg-board-border disabled:opacity-50";
export function CreationRecovery<D>({ work }: { work: ShowCreationWork<D> }) {
  const attempt = work.attempt;
  return (
    <div className="space-y-2 text-sm break-words" aria-live="polite">
      {false && work.notice && (
        <p role="status" className="text-board-muted">
          {work.notice}
        </p>
      )}
      {attempt?.kind === "creating" && (
        <p role="status">
          <QuietActivity label="Creating show" />
        </p>
      )}
      {attempt?.kind === "reviewing" && (
        <QuietActivity label="Checking the original request before allowing edits…" />
      )}
      {attempt?.kind === "unconfirmed" && (
        <>
          <p role="alert" className="text-red-300">
            This show could not be created.
          </p>
          <p className="text-board-muted">
            Your draft is kept.
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

          {attempt.opening === "failed" && (
            <p role="alert" className="text-red-300">
              This show could not be opened.
            </p>
          )}
          <button
            type="button"
            className={button}
            disabled={attempt.opening === "pending"}
            onClick={work.open}
           aria-label={attempt.opening === "pending"
              ? "Opening show…"
              : attempt.opening === "failed"
                ? "Retry opening show"
                : "Open show"}>
            {attempt.opening === "pending"
              ? <QuietActivity label="Opening show…" />
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
