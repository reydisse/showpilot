import type { NotificationCategory } from "@showpilot/shared";
import { useNotificationPreferences } from "@/hooks/useNotificationPreferences";

const copy: Record<
  NotificationCategory,
  { label: string; description: string }
> = {
  schedule: {
    label: "Schedule",
    description: "Assignments, duty reminders and responses",
  },
  incidents: { label: "Incidents", description: "Issues, replies and changes" },
  chat: { label: "Chat", description: "Messages, mentions and reactions" },
  reports: { label: "Reports", description: "Post-show note requests" },
  system: {
    label: "Admin and safety",
    description: "Workspace and safety reviews",
  },
};
const buttonClass =
  "min-h-11 rounded-lg border border-board-border px-3 text-sm text-board-text focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50";
export function NotificationPreferences({
  orgId,
  userId,
}: {
  orgId: string;
  userId: string;
}) {
  const controls = useNotificationPreferences(orgId, userId);
  const { query, unfinished, result } = controls;
  return (
    <section aria-label="Your notification categories" className="space-y-3">
      <p className="text-sm text-board-muted">
        These choices apply only to your account in this workspace. Everything
        stays in your inbox. Device alerts also require device permission and
        the organization's notification policy.
      </p>
      {query.isPending && !query.isError && (
        <p role="status" className="text-sm text-board-muted">
          Loading your alert choices…
        </p>
      )}
      {query.isError && (
        <div role="alert" className="space-y-2 text-sm text-amber-300">
          <p>
            Notification choices could not be refreshed.{" "}
            {query.error instanceof Error ? query.error.message : "Try again."}
          </p>
          <button
            className={buttonClass}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry preferences refresh
          </button>
        </div>
      )}
      {unfinished?.status === "pending" && (
        <p role="status" className="text-sm text-board-muted">
          Saving your alert choice… Waiting for confirmation.
        </p>
      )}
      {unfinished?.status === "error" && (
        <div role="alert" className="space-y-2 text-sm text-amber-300">
          <p>
            Your alert choice was not confirmed.{" "}
            {unfinished.error instanceof Error
              ? unfinished.error.message
              : "Check your connection."}{" "}
            The saved choice is shown until confirmation.
          </p>
          <p>
            Last attempt{" "}
            <time dateTime={new Date(unfinished.at).toISOString()}>
              {new Date(unfinished.at).toLocaleTimeString()}
            </time>
          </p>
          <button className={buttonClass} onClick={controls.retry}>
            Retry preference save
          </button>
        </div>
      )}
      {!unfinished && result && (
        <p role="status" className="text-sm text-board-muted">
          {result.outcome === "applied"
            ? "Alert choice saved."
            : result.outcome === "conflict"
              ? "This choice changed elsewhere. The saved value is shown. Review it before changing it again."
              : "A newer alert choice is in effect. Retrying did not replace it."}
        </p>
      )}
      {query.data?.map((preference) => (
        <div
          key={preference.category}
          className="flex min-h-16 items-center gap-3 border-b border-board-border py-2 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-board-text">
              {copy[preference.category].label}
            </p>
            <p className="text-xs leading-5 text-board-muted">
              {copy[preference.category].description}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={`${copy[preference.category].label} device alerts`}
            aria-checked={preference.deviceAlerts}
            disabled={controls.locked}
            onClick={() => controls.change(preference)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-fire-500 disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className={`relative h-6 w-11 rounded-full ${preference.deviceAlerts ? "bg-fire-500" : "bg-board-border"}`}
            >
              <span
                className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform ${preference.deviceAlerts ? "translate-x-5" : ""}`}
              />
            </span>
          </button>
        </div>
      ))}
    </section>
  );
}
