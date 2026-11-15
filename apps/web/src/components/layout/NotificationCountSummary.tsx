import type { NotificationCountState } from "@/lib/account-notification-count";
import { Button } from "@/components/ui/button";
import { QuietActivity } from "@/components/ui/QuietActivity";
export function NotificationCountSummary({ state, onRetry }: { state: NotificationCountState; onRetry: () => void }) {
  // Counts belong to the bell badge. A successful poll has nothing to announce.
  if (state.kind !== "failed") return null;
  return <div role="alert" aria-label="Notification count recovery" className="space-y-2 px-3 py-3 text-xs text-amber-700 dark:text-amber-300">
    <p>Notifications could not be updated.</p>
    <Button type="button" variant="outline" className="min-h-11" disabled={state.retrying} onClick={onRetry}>{state.retrying ? <QuietActivity label="Retrying…" /> : "Retry notifications"}</Button>
  </div>;
}
