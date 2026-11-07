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
          <p>{read.error?.message ?? "Retrying the failed roster read. Your selections are retained."}</p>
          <p>
            Last failed read{" "}
            <time dateTime={new Date(read.errorUpdatedAt).toISOString()}>
              {new Date(read.errorUpdatedAt).toLocaleTimeString()}
            </time>
          </p>
          <Button
            variant="outline"
            className="min-h-11 h-auto whitespace-normal"
            aria-label="Retry roster week"
            disabled={read.isFetching}
            onClick={() => void read.refetch()}
          >
            {read.isFetching ? "Retrying roster week…" : "Retry roster week"}
          </Button>
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="text-board-muted">
          Waiting for the roster command to be confirmed…
        </p>
      ) : null}
      {unfinished && !pending ? (
        <div role="alert" className="space-y-2 text-amber-200">
          <p>
            {latest?.error instanceof Error
              ? latest.error.message
              : "Roster command was not confirmed."}{" "}
            The original command is for {unfinished.weekStart}; your selections
            are retained.
          </p>
          <p>
            Last attempt{" "}
            <time dateTime={new Date(latest?.at ?? 0).toISOString()}>
              {new Date(latest?.at ?? 0).toLocaleTimeString()}
            </time>
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
            ? `The original roster command for ${latest.command?.weekStart} was saved. The latest confirmed assignments are shown below.`
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
              : "Some duty notifications are awaiting delivery confirmation. The saved assignments are kept."}
          </p>
          {notices.isError ? (
            <p>
              Last delivery attempt{" "}
              <time dateTime={new Date(notices.submittedAt).toISOString()}>
                {new Date(notices.submittedAt).toLocaleTimeString()}
              </time>
            </p>
          ) : null}
          <Button
            variant="outline"
            className="min-h-11 h-auto whitespace-normal"
            disabled={notices.isPending}
            onClick={() => notices.mutate()}
          >
            {notices.isPending
              ? "Checking delivery…"
              : "Retry duty notifications"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
