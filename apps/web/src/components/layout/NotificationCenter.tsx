import { useNavigate } from "@tanstack/react-router";
import { NotificationPreferences } from "@/components/settings/NotificationPreferences";
import { BellRing, CheckCheck, ExternalLink, Inbox, Info, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useNotificationInbox } from "@/hooks/useNotificationInbox";
import { Button } from "@/components/ui/button";
import type { PersonalNotification } from "@/lib/personal-notifications";
import { getNotificationDestination } from "@/lib/notification-destination";

interface NotificationInboxProps {
  orgId: string;
  userId: string;
  slug: string;
  onUnreadChange?: (count: number) => void;
  onNavigate?: () => void;
}

export function NotificationInbox({ orgId, userId, slug, onUnreadChange, onNavigate }: NotificationInboxProps) {
  const navigate = useNavigate();
  const [showPreferences, setShowPreferences] = useState(false);
  const { inbox, unread, commands, pending, markRead, retryRead, items } = useNotificationInbox(orgId, userId, onUnreadChange);
  const readFailed = inbox.isError || (inbox.isFetching && inbox.errorUpdatedAt > inbox.dataUpdatedAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-board-border px-5 py-2 sm:px-6">
        <Button type="button" variant="ghost" size="sm" className="min-h-11" aria-expanded={showPreferences} onClick={() => setShowPreferences((value) => !value)}>
          <SlidersHorizontal data-icon="inline-start" />
          Preferences
        </Button>
        {unread !== undefined && unread > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="min-h-11" disabled={commands.length > 0} onClick={() => markRead(null)}>
            <CheckCheck data-icon="inline-start" />
            Mark all read
          </Button>
        ) : null}
      </div>

      <div hidden={!showPreferences} className="modern-scrollbar max-h-80 shrink-0 overflow-y-auto border-b border-board-border bg-board-bg/25 px-5 py-4 sm:px-6">
        <NotificationPreferences orgId={orgId} userId={userId} />
      </div>

      <div data-testid="notification-list" className="modern-scrollbar min-h-0 flex-1 touch-pan-y divide-y divide-board-border/70 overflow-y-auto overscroll-contain">
        {pending ? <p role="status" className="px-5 py-3 text-sm text-board-muted">Confirming read status…</p> : null}
        {commands.map(attempt => attempt.status === "uncertain" ? (
          <div key={attempt.command.requestId} role="alert" className="space-y-2 px-5 py-3 text-sm text-amber-700 dark:text-amber-300">
            <p>{attempt.command.notificationId === null ? "Mark all read" : "Mark as read"} was not confirmed and may have saved. Retry checks the same action without repeating a saved change.</p>
            <p>Last failed attempt <time dateTime={new Date(attempt.occurredAt).toISOString()}>{new Date(attempt.occurredAt).toLocaleTimeString()}</time></p>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => retryRead(attempt.command)}>Retry read status</Button>
          </div>
        ) : null)}
        {readFailed ? <div role="alert" className="space-y-2 px-5 py-3 text-sm text-red-700 dark:text-red-300">
          <p>{inbox.isFetchNextPageError ? "Older notifications could not be loaded." : "Notifications could not be refreshed."} {inbox.data ? "Showing the last confirmed inbox." : "Retry to check your inbox."}</p>
          <p>Last failed read <time dateTime={new Date(inbox.errorUpdatedAt).toISOString()}>{new Date(inbox.errorUpdatedAt).toLocaleTimeString()}</time></p>
          <Button type="button" variant="outline" className="min-h-11" disabled={inbox.isFetching || pending} onClick={() => { void (inbox.isFetchNextPageError ? inbox.fetchNextPage({ cancelRefetch: false }) : inbox.refetch({ cancelRefetch: false })); }}>{inbox.isFetching ? "Retrying…" : "Retry notifications"}</Button>
        </div> : null}
        {inbox.isPending && !readFailed ? <NotificationSkeleton /> : null}
        {inbox.data && !readFailed && items.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl border border-board-border bg-board-bg/40 text-board-muted">
              <Inbox className="size-6" />
            </span>
            <p className="mt-4 text-sm font-medium text-board-text">Nothing waiting for you.</p>
            <p className="mt-1 max-w-64 text-xs leading-5 text-board-muted">Assignments, mentions, and operational alerts will appear here.</p>
          </div>
        ) : null}
        {items.map((item) => (
          <NotificationRow
            key={item.id}
            item={item}
            onOpen={async () => {
              if (!item.readAt) markRead(item.id);
              if (!getNotificationDestination(item.actionUrl)) return;
              onNavigate?.();
              await navigateToNotification(navigate, slug, item.actionUrl);
            }}
          />
        ))}
        {inbox.hasNextPage && !readFailed ? (
          <div className="flex justify-center px-5 py-4 sm:px-6">
            <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={inbox.isFetching || pending} onClick={() => void inbox.fetchNextPage({ cancelRefetch: false })}>
              {inbox.isFetchingNextPage ? "Loading…" : "Load older notifications"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotificationSkeleton() {
  return (
    <div aria-label="Loading notifications" className="flex flex-col gap-0">
      {[0, 1, 2].map((item) => (
        <div key={item} className="flex gap-3 border-b border-board-border/70 px-5 py-4 sm:px-6">
          <SkeletonBlock className="size-9 shrink-0 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <SkeletonBlock className="h-3 w-2/5" />
            <SkeletonBlock className="h-3 w-full" />
            <SkeletonBlock className="h-2.5 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SkeletonBlock({ className }: { className: string }) {
  return <div aria-hidden="true" className={`animate-pulse bg-board-border/70 ${className}`} />;
}

function NotificationRow({ item, onOpen }: { item: PersonalNotification; onOpen(): Promise<void> }) {
  const critical = item.severity === "critical" || item.severity === "high";
  const warning = item.severity === "warning" || item.severity === "medium";
  const Icon = critical ? TriangleAlert : warning ? BellRing : Info;
  const iconLabel = critical ? "Critical" : warning ? "Warning" : "Information";

  return (
    <button
      type="button"
      onClick={() => void onOpen()}
      className={`flex w-full items-start gap-3 px-5 py-4 text-left transition-colors hover:bg-board-border/30 sm:px-6 ${item.readAt ? "opacity-75" : "bg-fire-500/[.035]"}`}
    >
      <span
        aria-label={iconLabel}
        className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border ${critical ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400" : warning ? "border-amber-400/25 bg-amber-400/10 text-amber-700 dark:text-amber-300" : "border-board-border bg-board-bg/45 text-board-muted"}`}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <strong className="min-w-0 flex-1 text-sm font-medium text-board-text">{item.title}</strong>
          <span className="shrink-0 text-[10px] text-board-muted/70">{relativeTime(item.createdAt)}</span>
        </span>
        <span className="mt-1 block break-words text-xs leading-5 text-board-muted [overflow-wrap:anywhere]">{item.message}</span>
        {!item.readAt ? <span className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-medium text-fire-800 dark:text-fire-500"><span className="size-1.5 rounded-full bg-fire-500" />Unread</span> : null}
      </span>
      {item.actionUrl ? <ExternalLink aria-label="Open notification" className="mt-1 size-3.5 shrink-0 text-board-muted" /> : null}
    </button>
  );
}

type Navigate = ReturnType<typeof useNavigate>;

async function navigateToNotification(navigate: Navigate, slug: string, actionUrl: string) {
  const destination = getNotificationDestination(actionUrl);
  if (!destination) return;
  if (destination.kind === "tech-manager") {
    await navigate({ to: "/$slug/dashboard/tech-manager", params: { slug }, search: { date: undefined, show: undefined } });
    return;
  }
  if (destination.kind === "incident") {
    await navigate({ to: "/$slug/production/incidents", params: { slug }, search: { incident: destination.incident, date: destination.date, show: destination.show } });
    return;
  }
  if (destination.kind === "schedule") {
    await navigate({ to: "/$slug/schedule", params: { slug }, search: { date: destination.date, assignment: destination.assignment } });
    return;
  }
  if (destination.kind === "personal-duty") {
    await navigate({ to: "/$slug/assignments", params: { slug }, search: { date: destination.date, assignment: undefined } });
    return;
  }
  if (destination.kind === "personal-assignment") {
    await navigate({
      to: "/$slug/assignments",
      params: { slug },
      search: { assignment: destination.assignment, date: undefined },
    });
    return;
  }
  if (destination.kind === "report") {
    await navigate({ to: "/$slug/reports", params: { slug }, search: { date: destination.date, show: destination.show, page: 1 } });
    return;
  }
  if (destination.kind === "feature") {
    switch (destination.path) {
      case "rundown":
        await navigate({ to: "/$slug/rundown", params: { slug } });
        break;
      case "board":
        await navigate({ to: "/$slug/board", params: { slug } });
        break;
      case "production/cue-sheets":
        await navigate({ to: "/$slug/production/cue-sheets", params: { slug } });
        break;
      case "production/checklist":
        await navigate({ to: "/$slug/production/checklist", params: { slug } });
        break;
      case "checkin":
        await navigate({ to: "/$slug/checkin", params: { slug } });
        break;
      case "timecode":
        await navigate({ to: "/$slug/timecode", params: { slug } });
        break;
      case "streaming/graphics":
        await navigate({ to: "/$slug/streaming/graphics", params: { slug } });
        break;
      case "streaming/health":
        await navigate({ to: "/$slug/streaming/health", params: { slug } });
        break;
      case "production/assets":
        await navigate({ to: "/$slug/production/assets", params: { slug } });
        break;
      case "dashboard/prod-manager":
        await navigate({ to: "/$slug/dashboard/prod-manager", params: { slug }, search: { date: undefined, show: undefined } });
        break;
      default: {
        const exhaustivePath: never = destination.path;
        return exhaustivePath;
      }
    }
    return;
  }
  await navigate({ to: "/$slug/chat", params: { slug }, search: { room: destination.room, message: destination.message } });
}

function relativeTime(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
