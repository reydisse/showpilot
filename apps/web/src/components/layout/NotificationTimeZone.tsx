import { QuietActivity } from "@/components/ui/QuietActivity";
import { ClockAlert } from "lucide-react";
import { useNotificationTimeZone } from "@/hooks/useNotificationTimeZone";
import { Button } from "@/components/ui/button";

type Props = { orgId: string; userId: string } & (
  | { mode: "background"; onReview: () => void }
  | { mode: "status" }
);
export function NotificationTimeZone(props: Props) {
  const controls = useNotificationTimeZone(
    props.orgId,
    props.userId,
    props.mode === "background",
  );
  const { query, unfinished, readFailed, result, deviceZone } = controls;
  if (props.mode === "background")
    return readFailed || unfinished?.status === "error" ? (
      <button
        type="button"
        aria-label="Alert timezone needs attention"
        title="Alert timezone needs attention"
        onClick={props.onReview}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-amber-500 hover:bg-board-border/50"
      >
        <ClockAlert className="size-4" />
      </button>
    ) : null;
  const locked = !!unfinished || readFailed || query.isFetching || !query.data;
  return (
    <section
      aria-label="Alert timezone"
      className="space-y-2 border-t border-board-border px-3 py-3 text-xs text-board-muted"
    >
      <p className="font-medium text-board-text">Alert timezone</p>
      {query.data ? (
        <p>
          Timezone:{query.data.timeZone ?? "workspace default"}.
          Assignment emails use your saved timezone.
        </p>
      ) : null}
      {query.isPending && !readFailed ? (
        <QuietActivity label="Checking alert timezone…" />
      ) : null}
      {readFailed ? (
        <div
          role="alert"
          className="space-y-2 text-amber-700 dark:text-amber-300"
        >
          <p>
            Alert timezone could not be loaded.</p>

          <Button
            className="min-h-11"
            variant="outline"
            disabled={query.isFetching || unfinished?.status === "pending"}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? <QuietActivity label="Retrying…" /> : "Retry timezone check"}
          </Button>
        </div>
      ) : null}
      {unfinished?.status === "pending" ? (
        <QuietActivity label="Saving alert timezone…" />
      ) : null}
      {unfinished?.status === "error" ? (
        <div
          role="alert"
          className="space-y-2 text-amber-700 dark:text-amber-300"
        >
          <p>
            Your timezone change needs attention.</p>

          <Button
            className="min-h-11"
            variant="outline"
            onClick={controls.retry}
          >
            Retry timezone save
          </Button>
        </div>
      ) : null}
      {!unfinished && result?.outcome !== "applied" && result ? (
        <p role="status">
          Your timezone was changed elsewhere.</p>
      ) : null}
      {query.data && query.data.timeZone !== deviceZone ? (
        <Button
          className="h-auto min-h-11 whitespace-normal text-left"
          variant="outline"
          disabled={locked}
          onClick={controls.change}
        >
          Use this device’s timezone ({deviceZone})
        </Button>
      ) : null}
    </section>
  );
}
