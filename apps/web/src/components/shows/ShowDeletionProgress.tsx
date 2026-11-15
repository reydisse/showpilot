import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import type { useShowDeletions } from "@/hooks/useShowDeletions";

const buttonClass =
  "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm font-semibold disabled:opacity-50";
export function ShowDeletionProgress({
  controller,
}: {
  controller: ReturnType<typeof useShowDeletions>;
}) {
  const entries = Object.values(controller.work).filter(
    (work) => work && work.kind !== "confirming",
  );
  if (!entries.length) return null;
  return (
    <section
      aria-label="Show deletion progress"
      className="mx-auto max-w-[1700px] space-y-3 px-4 py-3 md:px-6"
    >
      {entries.map(
        (work) =>
          work && (
            <div
              key={work.target.showId}
              className="min-w-0 rounded-xl border border-board-border bg-board-card p-4"
            >
              <h2 className="break-words text-sm font-semibold">
                {work.target.name || "Untitled show"}
              </h2>
              {work.kind === "deleting" && (
                <QuietActivity />
              )}
              {work.kind === "unconfirmed" && (
                <>
                  <p
                    role="alert"
                    className="mt-2 text-sm leading-6 text-red-300"
                  >
                    {plainFailure((work.message) ?? "")}</p>
                  <button
                    className={`${buttonClass} mt-3`}
                    onClick={() => void controller.retry(work.target.showId)}
                  >
                    Retry deletion
                  </button>
                </>
              )}
              {work.kind === "rejected" && (
                <>
                  <p
                    role="alert"
                    className="mt-2 text-sm leading-6 text-red-300"
                  >
                    {plainFailure((work.message) ?? "")}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className={buttonClass}
                      disabled={work.refresh === "pending"}
                      onClick={() =>
                        void controller.refresh(work.target.showId)
                      }
                     aria-label={work.refresh === "pending"
                        ? "Refreshing…"
                        : "Refresh Schedule"}>
                      {work.refresh === "pending"
                        ? <QuietActivity label="Refreshing…" />
                        : "Refresh Schedule"}
                    </button>
                    <button
                      className={buttonClass}
                      disabled={work.refresh === "pending"}
                      onClick={() => controller.dismiss(work.target.showId)}
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
              {work.kind === "deleted" && (
                <>
                  <p role="status" className="mt-2 text-sm leading-6">
                    Show deleted.
                    {work.refresh === "pending" ? <QuietActivity label=" Refreshing Schedule…" /> : ""}
                  </p>
                  {work.message && (
                    <p
                      role="alert"
                      className="mt-2 text-sm leading-6 text-red-300"
                    >
                      {plainFailure((work.message) ?? "")} </p>
                  )}
                  <button
                    className={`${buttonClass} mt-3`}
                    disabled={work.refresh === "pending"}
                    onClick={() =>
                      work.refresh === "done"
                        ? controller.dismiss(work.target.showId)
                        : void controller.refresh(work.target.showId)
                    }
                   aria-label={work.refresh === "done"
                      ? "Dismiss"
                      : work.refresh === "pending"
                        ? "Refreshing…"
                        : "Refresh Schedule"}>
                    {work.refresh === "done"
                      ? "Dismiss"
                      : work.refresh === "pending"
                        ? <QuietActivity label="Refreshing…" />
                        : "Refresh Schedule"}
                  </button>
                </>
              )}
            </div>
          ),
      )}
    </section>
  );
}
