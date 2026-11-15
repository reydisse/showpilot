import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { Button } from "@/components/ui/button";
import type { useDutyRoster } from "@/hooks/useDutyRoster";
export function DutyRosterFeedback({
  roster,
}: {
  roster: ReturnType<typeof useDutyRoster>;
}) {
  const { read, latest, pending, unfinished, notices } = roster;
  const readFailed = read.isError || (read.isFetching && read.errorUpdatedAt > 0);
  return (
    <div className="space-y-3 text-sm">
      {readFailed ? (
        <div
          role="alert"
          aria-label="Retry roster week"
          className="space-y-2 text-amber-200"
        >
          <p>{read.error?.message ?? <QuietActivity label="Retrying the failed roster read. Your selections are retained." />}</p>

          <Button
            variant="outline"
            className="min-h-11 h-auto whitespace-normal"
            aria-label="Retry roster week"
            disabled={read.isFetching}
            onClick={() => void read.refetch()}
          >
            {read.isFetching ? <QuietActivity label="Retrying roster week…" /> : "Retry roster week"}
          </Button>
        </div>
      ) : null}
      {pending ? (
        <QuietActivity label="Saving roster…" />
      ) : null}
      {unfinished && !pending ? (
        <div role="alert" className="space-y-2 text-amber-200">
          <p>
            {plainFailure((latest?.error instanceof Error
              ? latest.error.message
              : "This change needs attention.") ?? "")}{" "}
            The original command is for {unfinished.weekStart}; your selections
            are retained.
          </p>

          <Button
            variant="outline"
            className="min-h-11 h-auto whitespace-normal"
            onClick={roster.retry}
          >
            Retry roster command
          </Button>
        </div>
      ) : null}
      {!unfinished && latest?.result ? (
        <p
          role={latest.result.outcome === "applied" ? "status" : "alert"}
          className="text-board-muted"
        >
          {latest.result.outcome === "applied"
            ? ""
            : latest.result.outcome === "role-code-taken"
              ? "That role code already exists. Choose a different code; the existing role was kept."
              : latest.result.outcome === "member-unavailable"
                ? "A selected person is no longer in this organization. Your command was not applied. Choose a current member."
                : "The roster or role changed after you reviewed it. Your command was not applied. Review the current roster before saving again."}
        </p>
      ) : null}
      {(read.data?.pendingNotifications ?? 0) > 0 || notices.isError ? (
        <div role="status" className="space-y-2 text-amber-200">
          <p>
            {notices.isError
              ? notices.error.message
              : "Some duty alerts could not be sent."}
          </p>

          <Button
            variant="outline"
            className="min-h-11 h-auto whitespace-normal"
            disabled={notices.isPending}
            onClick={() => notices.mutate()}
          >
            {notices.isPending
              ? <QuietActivity label="Checking delivery…" />
              : "Retry duty notifications"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
