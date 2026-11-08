import { useDesktopNotificationDelivery } from "./DesktopNotificationContext";
import type { NotificationDeliveryStage } from "@/lib/desktop-notification-state";

export function DesktopNotificationNotice() {
  const delivery = useDesktopNotificationDelivery();
  if (!delivery) return null;
  const { state, retry } = delivery;
  const failure = (stage: NotificationDeliveryStage) =>
    stage.kind === "failed"
      ? stage.failure
      : stage.kind === "working"
        ? stage.previousFailure
        : null;
  const errors =
    state.kind === "load-failed"
      ? [state.failure]
      : state.kind === "starting" && state.previousFailure
        ? [state.previousFailure]
        : state.kind === "running"
          ? [failure(state.inbox), failure(state.actions)].filter(
              (item) => item !== null,
            )
          : [];
  if (!errors.length) return null;
  const busy =
    state.kind === "starting" ||
    (state.kind === "running" &&
      (state.inbox.kind === "working" || state.actions.kind === "working"));
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-500/30 bg-board-card px-4 py-3 text-xs text-board-text"
    >
      <div className="min-w-0 flex-1 space-y-1">
        {errors.map((error) => (
          <p key={error.message}>
            {error.message}{" "}
            <time
              className="whitespace-nowrap text-board-muted"
              dateTime={new Date(error.at).toISOString()}
            >
              {new Date(error.at).toLocaleTimeString()}
            </time>
          </p>
        ))}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={retry}
        className="min-h-11 min-w-11 rounded-lg border border-board-border px-3 font-medium focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50"
      >
        {busy ? "Retrying alerts…" : "Retry desktop alerts"}
      </button>
    </div>
  );
}
