import {
  focusDesktopMainWindow,
  listenForDesktopNotificationActions,
  showDesktopNotification,
} from "./desktop-runtime";
import { getNotificationPath } from "./notification-destination";
import { getPersonalDeviceNotifications } from "./personal-notifications";
import { announcePersonalNotificationCount } from "./notification-events";
import { getOrgRouteContext } from "./session";
import { runRouteLoad } from "./route-load-deadlines";
import { UnsupportedDesktopNotificationActionsError } from "./desktop-notification-state";
import type {
  NotificationDeliveryChannel,
  NotificationDeliveryStage,
  NotificationFailure,
} from "./desktop-notification-state";

const HISTORY_LIMIT = 120;
function readHistory(key: string): Set<string> | null {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(key) ?? "null",
    );
    return Array.isArray(value)
      ? new Set(value.filter((id): id is string => typeof id === "string"))
      : null;
  } catch {
    return null;
  }
}

/** Each deadline fences late callbacks; accepted notifications checkpoint individually. */
export function startDesktopNotificationDelivery({
  slug,
  signal,
  onStatus,
}: {
  slug: string;
  signal: AbortSignal;
  onStatus: (
    channel: NotificationDeliveryChannel,
    status: NotificationDeliveryStage,
  ) => void;
}) {
  let polling = false,
    registering = false,
    actionsUnsupported = false;
  let context: Awaited<ReturnType<typeof getOrgRouteContext>> | null = null;
  let memory: { key: string; ids: Set<string> } | null = null;
  let unlisten: (() => Promise<void>) | undefined;
  const failures: Record<
    NotificationDeliveryChannel,
    NotificationFailure | null
  > = { inbox: null, actions: null };
  const begin = (channel: NotificationDeliveryChannel) =>
    onStatus(channel, { kind: "working", previousFailure: failures[channel] });
  const ready = (channel: NotificationDeliveryChannel) => {
    failures[channel] = null;
    onStatus(channel, { kind: "ready" });
  };
  const fail = (channel: NotificationDeliveryChannel, message: string) => {
    if (signal.aborted) return;
    const failure = { message, at: Date.now() };
    failures[channel] = failure;
    onStatus(channel, { kind: "failed", failure });
  };
  const retired = new Set<() => Promise<void>>();
  let retiring = false,
    cleanupFailed = false;
  const cleanRetired = async () => {
    if (retiring) return;
    retiring = true;
    try {
      await Promise.all(
        [...retired].map(async (remove) => {
          try {
            await runRouteLoad(() => remove(), undefined, 8_000);
            retired.delete(remove);
          } catch {
            cleanupFailed = true;
            fail(
              "actions",
              "A previous desktop alert connection could not close. Retry desktop alerts.",
            );
          }
        }),
      );
      if (!retired.size && cleanupFailed) {
        cleanupFailed = false;
        if (unlisten && !signal.aborted) ready("actions");
      }
    } finally {
      retiring = false;
    }
  };
  const retire = (remove: () => Promise<void>) => {
    retired.add(remove);
    void cleanRetired();
  };
  const checkpoint = (key: string, ids: Set<string>, newest?: string) => {
    const kept = [...new Set([...(newest ? [newest] : []), ...ids])].slice(
      0,
      HISTORY_LIMIT,
    );
    memory = { key, ids: new Set(kept) };
    try {
      window.localStorage.setItem(key, JSON.stringify(kept));
    } catch {
      /* Memory remains authoritative for this app session. */
    }
    return memory.ids;
  };
  const poll = async () => {
    if (signal.aborted || polling) return;
    polling = true;
    begin("inbox");
    let reading = true;
    try {
      const allowed = await runRouteLoad(
        async (controller) => {
          const checked = () => controller.signal.throwIfAborted();
          if (!context) {
            const found = await getOrgRouteContext({
              data: slug,
              signal: controller.signal,
            });
            checked();
            context = found;
          }
          if (!context) throw new Error("Account context unavailable");
          const result = await getPersonalDeviceNotifications({
            data: { orgId: context.org.id },
            signal: controller.signal,
          });
          checked();
          if (
            result.userId !== context.user.id ||
            result.orgId !== context.org.id
          )
            throw new Error("Notification account changed");
          announcePersonalNotificationCount(context.org.id, result.unread);
          const key = `showpilot.desktop-notifications.v1:${context.user.id}:${context.org.id}`;
          const history = memory?.key === key ? memory.ids : readHistory(key);
          // First installation establishes a baseline without a burst of old alerts.
          let accepted = checkpoint(
            key,
            history ?? new Set(result.notifications.map((item) => item.id)),
          );
          reading = false;
          if (history) {
            for (const item of [...result.notifications].reverse()) {
              checked();
              if (accepted.has(item.id)) continue;
              if (!item.readAt) {
                const shown = await showDesktopNotification(
                  item.title,
                  item.message,
                  {
                    notificationId: item.id,
                    actionUrl: item.actionUrl,
                    orgSlug: slug,
                  },
                  controller.signal,
                );
                checked();
                if (!shown) return false;
              }
              accepted = checkpoint(key, accepted, item.id);
            }
          }
          return true;
        },
        signal,
        8_000,
      );
      if (signal.aborted) return;
      if (allowed) ready("inbox");
      else
        fail(
          "inbox",
          "Desktop alerts are blocked. Enable notifications in system settings, then retry.",
        );
    } catch {
      context = null;
      fail(
        "inbox",
        reading
          ? "Desktop alerts could not be checked. Retrying automatically."
          : "Desktop alerts could not be delivered. Retrying automatically.",
      );
    } finally {
      polling = false;
    }
  };
  const register = async () => {
    if (signal.aborted || registering || unlisten || actionsUnsupported) return;
    registering = true;
    begin("actions");
    let abandoned = false;
    try {
      await runRouteLoad(
        async (controller) => {
          const remove = await listenForDesktopNotificationActions(
            (payload) => {
              if (signal.aborted || abandoned) return;
              const path = payload.actionUrl
                ? getNotificationPath(payload.orgSlug, payload.actionUrl)
                : payload.orgSlug.length <= 64 &&
                    /^[a-zA-Z0-9-]+$/.test(payload.orgSlug)
                  ? `/${payload.orgSlug}`
                  : null;
              if (!path) return;
              // A stalled native focus operation must not swallow the requested navigation.
              void runRouteLoad(() => focusDesktopMainWindow(), signal, 3_000)
                .catch(() => undefined)
                .then(() => {
                  if (!signal.aborted && !abandoned)
                    window.location.assign(path);
                });
            },
          );
          if (controller.signal.aborted || signal.aborted || abandoned) {
            retire(remove);
            return;
          }
          unlisten = remove;
        },
        signal,
        8_000,
      );
      if (!signal.aborted && !cleanupFailed) ready("actions");
    } catch (cause) {
      abandoned = true;
      actionsUnsupported = cause instanceof UnsupportedDesktopNotificationActionsError;
      fail(
        "actions",
        actionsUnsupported
          ? (cause as UnsupportedDesktopNotificationActionsError).message
          : "Desktop alert actions could not connect. Retrying automatically.",
      );
    } finally {
      registering = false;
    }
  };
  const refresh = () => {
    void poll();
    void register();
    void cleanRetired();
  };
  const timer = window.setInterval(refresh, 15_000);
  signal.addEventListener(
    "abort",
    () => {
      window.clearInterval(timer);
      if (unlisten) retire(unlisten);
    },
    { once: true },
  );
  refresh();
  return { refresh: () => { actionsUnsupported = false; refresh(); } };
}
