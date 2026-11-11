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
          Last confirmed timezone: {query.data.timeZone ?? "workspace default"}.
          Assignment emails use your saved timezone.
        </p>
      ) : null}
      {query.isPending && !readFailed ? (
        <p role="status">Checking alert timezone…</p>
      ) : null}
      {readFailed ? (
        <div
          role="alert"
          className="space-y-2 text-amber-700 dark:text-amber-300"
        >
          <p>
            Alert timezone could not be checked. Retry to check the current
            saved timezone.
          </p>
          <p>
            Last failed read{" "}
            <time dateTime={new Date(query.errorUpdatedAt).toISOString()}>
              {new Date(query.errorUpdatedAt).toLocaleTimeString()}
            </time>
          </p>
          <Button
            className="min-h-11"
            variant="outline"
            disabled={query.isFetching || unfinished?.status === "pending"}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Retrying…" : "Retry timezone check"}
          </Button>
        </div>
      ) : null}
      {unfinished?.status === "pending" ? (
        <p role="status">Saving alert timezone… Waiting for confirmation.</p>
      ) : null}
      {unfinished?.status === "error" ? (
        <div
          role="alert"
          className="space-y-2 text-amber-700 dark:text-amber-300"
        >
          <p>
            Timezone save was not confirmed and may have saved. Retry confirms
            the same update.
          </p>
          <p>
            Last attempt{" "}
            <time dateTime={new Date(unfinished.at).toISOString()}>
              {new Date(unfinished.at).toLocaleTimeString()}
            </time>
          </p>
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
          A newer timezone is in effect. Retrying did not replace it.
        </p>
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
