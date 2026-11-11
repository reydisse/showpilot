import { useCallback, useEffect } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  getPersonalNotifications,
  markAllPersonalNotificationsRead,
  markPersonalNotificationRead,
  type NotificationCursor,
} from "@/lib/personal-notifications";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import { isDesktopRuntime } from "@/lib/desktop-runtime";
import {
  PERSONAL_NOTIFICATION_COUNT_EVENT,
  readPersonalNotificationCount,
} from "@/lib/notification-events";

type ReadCommand = {
  orgId: string;
  requestId: string;
  notificationId: string | null;
};
type ReadAttempt = { command: ReadCommand } & (
  | { status: "pending" }
  | { status: "uncertain"; occurredAt: number }
);
const inboxKey = (orgId: string, userId: string) => [
  "notification-inbox",
  orgId,
  userId,
];
const commandsKey = (orgId: string, userId: string) => [
  "notification-inbox-commands",
  orgId,
  userId,
];

// Execution belongs to the account cache, not the panel. Opening an alert may
// navigate away before its acknowledgement; reopening still exposes its retry.
async function executeRead(
  client: QueryClient,
  userId: string,
  command: ReadCommand,
) {
  const key = commandsKey(command.orgId, userId);
  const queries = { queryKey: inboxKey(command.orgId, userId), exact: true };
  const previous = client.getQueryData<ReadAttempt[]>(key) ?? [];
  if (
    previous.some(
      (item) =>
        item.command.requestId === command.requestId &&
        item.status === "pending",
    )
  )
    return;
  client.setQueryData<ReadAttempt[]>(key, (current) => [
    ...(current ?? []).filter(
      (item) => item.command.requestId !== command.requestId,
    ),
    { command, status: "pending" },
  ]);
  try {
    await client.cancelQueries(queries);
    const result = await runRouteLoad(
      (controller) =>
        command.notificationId === null
          ? markAllPersonalNotificationsRead({
              data: { orgId: command.orgId, requestId: command.requestId },
              signal: controller.signal,
            })
          : markPersonalNotificationRead({
              data: {
                orgId: command.orgId,
                requestId: command.requestId,
                id: command.notificationId,
              },
              signal: controller.signal,
            }),
      undefined,
      8_000,
    );
    if (result.requestId !== command.requestId)
      throw new Error("Notification acknowledgement did not match the action.");
    client.setQueryData<ReadAttempt[]>(key, (current) =>
      (current ?? []).filter(
        (item) => item.command.requestId !== command.requestId,
      ),
    );
    await client.cancelQueries(queries);
    void client.invalidateQueries(queries);
  } catch {
    client.setQueryData<ReadAttempt[]>(key, (current) =>
      (current ?? []).map((item) =>
        item.command.requestId === command.requestId
          ? { command, status: "uncertain", occurredAt: Date.now() }
          : item,
      ),
    );
  }
}

export function useNotificationInbox(
  orgId: string,
  userId: string,
  onUnreadChange?: (count: number) => void,
) {
  const client = useQueryClient();
  const commands =
    useQuery<ReadAttempt[]>({
      queryKey: commandsKey(orgId, userId),
      queryFn: () => [],
      initialData: [],
      enabled: false,
      gcTime: Infinity,
    }).data ?? [];
  const pending = commands.some((item) => item.status === "pending");
  const inbox = useInfiniteQuery({
    queryKey: inboxKey(orgId, userId),
    initialPageParam: null as NotificationCursor | null,
    queryFn: ({ pageParam, signal }) =>
      runRouteLoad(
        (controller) =>
          getPersonalNotifications({
            data: { orgId, ...(pageParam ? { cursor: pageParam } : {}) },
            signal: controller.signal,
          }),
        signal,
        8_000,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
    networkMode: "always",
    enabled: !pending,
    refetchInterval: isDesktopRuntime() ? false : 20_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  // Pages load in sequence; the last completed page has the newest count.
  const unread = inbox.data?.pages.at(-1)?.unread;
  const { refetch } = inbox;
  const refresh = useCallback(() => {
    if (!pending && document.visibilityState !== "hidden")
      void refetch({ cancelRefetch: false });
  }, [refetch, pending]);
  useEffect(() => {
    if (unread !== undefined) onUnreadChange?.(unread);
  }, [unread, inbox.dataUpdatedAt, onUnreadChange]);
  useEffect(() => {
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const countChanged = (event: Event) => {
      const detail = readPersonalNotificationCount(event);
      if (detail?.orgId === orgId && detail.unread !== unread) refresh();
    };
    const message = (event: MessageEvent) => {
      if (event.data?.type === "showpilot-notification") refresh();
    };
    if (isDesktopRuntime())
      window.addEventListener(PERSONAL_NOTIFICATION_COUNT_EVENT, countChanged);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.addEventListener("message", message);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener(
        PERSONAL_NOTIFICATION_COUNT_EVENT,
        countChanged,
      );
      if ("serviceWorker" in navigator)
        navigator.serviceWorker.removeEventListener("message", message);
    };
  }, [orgId, refresh, unread]);
  const markRead = (notificationId: string | null) => {
    if (
      commands.some(
        (item) =>
          item.command.notificationId === null ||
          item.command.notificationId === notificationId,
      )
    )
      return;
    if (notificationId === null && commands.length > 0) return;
    void executeRead(client, userId, {
      orgId,
      notificationId,
      requestId: crypto.randomUUID(),
    });
  };
  return {
    inbox,
    unread,
    commands,
    pending,
    markRead,
    retryRead: (command: ReadCommand) => {
      void executeRead(client, userId, command);
    },
    items: inbox.data?.pages.flatMap((page) => page.notifications) ?? [],
  };
}
