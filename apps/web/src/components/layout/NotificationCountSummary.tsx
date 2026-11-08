import type { NotificationCountState } from "@/lib/account-notification-count";
import { Button } from "@/components/ui/button";

export function NotificationCountSummary({
  state,
  onRetry,
}: {
  state: NotificationCountState;
  onRetry: () => void;
}) {
  const unread = state.snapshot?.unread ?? null;
  return (
    <div className="mt-2 border-t border-board-border px-3 py-3 text-xs text-board-muted">
      {state.kind === "failed" ? (
        <div
          role="alert"
          aria-label="Notification count recovery"
          className="space-y-2 text-amber-700 dark:text-amber-300"
        >
          <p>
            Unread count unavailable.
            {unread !== null ? ` Last confirmed: ${unread} unread.` : ""}
          </p>
          <p>
            Last failed read{" "}
            <time dateTime={new Date(state.occurredAt).toISOString()}>
              {new Date(state.occurredAt).toLocaleTimeString()}
            </time>
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={state.retrying}
            onClick={onRetry}
          >
            {state.retrying ? "Retrying…" : "Retry notification count"}
          </Button>
        </div>
      ) : state.kind === "loading" ? (
        <p role="status">Checking notifications…</p>
      ) : (
        <p>
          {unread} unread notification{unread === 1 ? "" : "s"}
          <span className="mt-1 block">
            Checked{" "}
            <time dateTime={new Date(state.snapshot.confirmedAt).toISOString()}>
              {new Date(state.snapshot.confirmedAt).toLocaleTimeString()}
            </time>
          </span>
        </p>
      )}
    </div>
  );
}
