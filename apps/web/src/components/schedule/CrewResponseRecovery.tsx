import { useState } from "react";
import type {
  CrewPortalAssignment,
  CrewResponseEntry,
  useCrewResponseWork,
} from "@/hooks/useCrewResponseWork";
import type { CrewResponseResult } from "@/lib/crew-response-contract";
const button =
  "min-h-11 rounded-xl border border-board-border px-4 py-3 text-sm font-medium text-board-text disabled:opacity-50";
export function CrewResponseRecovery({
  entry,
  latest,
  work,
}: {
  entry: CrewResponseEntry;
  latest: CrewPortalAssignment | null;
  work: ReturnType<typeof useCrewResponseWork>;
}) {
  const id = entry.selection.id,
    attempt = entry.attempt;
  const [confirmation, setConfirmation] = useState<
    | { kind: "discard" }
    | { kind: "latest"; selection: CrewPortalAssignment }
    | null
  >(null);
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const finished =
    attempt?.kind === "confirmed" &&
    ["applied", "superseded", "removed"].includes(attempt.result.outcome);
  const canChange = !attempt || settled;
  const changed =
    latest &&
    (latest.revision !== entry.selection.revision ||
      latest.responseVersion !== entry.selection.responseVersion);
  return (
    <section
      aria-live="polite"
      className="mt-5 space-y-3 rounded-xl border border-board-border p-4 text-sm text-board-text"
    >
      {entry.validationError ? (
        <p role="alert" className="text-red-300">
          {entry.validationError}
        </p>
      ) : null}
      {attempt?.kind === "pending" ? (
        <p>
          Confirming your response… Your original request stays here if you
          switch assignments.
        </p>
      ) : null}
      {attempt?.kind === "unknown" ? (
        <>
          <p role="alert" className="text-red-300">
            Your response could not be confirmed. {attempt.message}
          </p>
          <p className="text-board-muted">
            It may already have saved. Retry sends the same response. Review
            checks it or cancels it before a delayed request can apply.
          </p>
          <div className="flex flex-wrap gap-3">
            <button className={button} onClick={() => work.retry(id)}>
              Retry original response
            </button>
            <button className={button} onClick={() => work.review(id)}>
              Review original response
            </button>
          </div>
        </>
      ) : null}
      {attempt?.kind === "confirmed" ? (
        <>
          <p>{resultMessage(attempt.result)}</p>
          {attempt.refresh === "pending" ? (
            <p>Refreshing your assignments…</p>
          ) : null}
          {attempt.refresh === "failed" || attempt.refresh === "idle" ? (
            <>
              <p role="alert" className="text-red-300">
                {attempt.message ?? "Refresh this page to finish."} The response
                outcome above is confirmed.
              </p>
              <button className={button} onClick={() => work.refresh(id)}>
                Refresh assignments only
              </button>
            </>
          ) : null}
          {settled && attempt.result.outcome === "cancelled" ? (
            <button
              disabled={!!confirmation}
              className={button}
              onClick={() => work.editCancelled(id)}
            >
              Edit cancelled response
            </button>
          ) : null}
          {settled && finished ? (
            <button
              disabled={!!confirmation}
              className={button}
              onClick={() => work.discard(id)}
            >
              Finish response
            </button>
          ) : null}
        </>
      ) : (
        <p className="text-board-muted">
          Your note stays with this assignment while you use this page.
        </p>
      )}
      {canChange && changed && latest ? (
        <button
          disabled={!!confirmation}
          className={button}
          onClick={() => setConfirmation({ kind: "latest", selection: latest })}
        >
          Review current assignment…
        </button>
      ) : null}
      {canChange && !finished ? (
        <button
          disabled={!!confirmation}
          className={button}
          onClick={() => setConfirmation({ kind: "discard" })}
        >
          Discard response draft…
        </button>
      ) : null}
      {confirmation ? (
        <div className="space-y-3 border-t border-board-border pt-3">
          <p>
            {confirmation.kind === "discard"
              ? "Discard this retained note and response result? This does not undo a saved response."
              : `Use the current details for ${confirmation.selection.role} on ${confirmation.selection.serviceDate} and keep your note? No response will be sent.`}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className={button}
              onClick={() => {
                if (confirmation.kind === "discard") work.discard(id);
                else work.useCurrent(confirmation.selection);
                setConfirmation(null);
              }}
            >
              {confirmation.kind === "discard"
                ? "Discard draft"
                : "Use current assignment"}
            </button>
            <button className={button} onClick={() => setConfirmation(null)}>
              Keep draft
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
function resultMessage(result: CrewResponseResult) {
  switch (result.outcome) {
    case "applied":
      return "Your response was saved.";
    case "superseded":
      return "Your response was saved before a later change. Review the current assignment.";
    case "removed":
      return "Your response was saved, and the assignment was later removed.";
    case "conflict":
      return "This assignment changed or already has a response. Your original response was not applied. Your note is retained.";
    case "closed":
      return "The response window closed before your response could be saved.";
    case "unavailable":
      return "This assignment is no longer available through this link.";
    case "cancelled":
      return "The original response was cancelled before it applied. Your note is retained.";
  }
}
