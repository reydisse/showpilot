import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import {
  DESKTOP_NOTIFICATION_POLL_EVENT,
  focusDesktopMainWindow,
  isDesktopMainWindow,
  isDesktopRuntime,
  listenForDesktopNotificationActions,
  showDesktopNotification,
} from "@/lib/desktop-runtime";
import { getNotificationPath } from "@/lib/notification-destination";
import { getPersonalNotifications } from "@/lib/personal-notifications";
import { getOrgRouteContext } from "@/lib/session";

const HISTORY_LIMIT = 120;

function storageKey(userId: string, orgId: string) {
  return `showpilot.desktop-notifications.v1:${userId}:${orgId}`;
}

function readHistory(key: string): Set<string> | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return Array.isArray(value)
      ? new Set(value.filter((id): id is string => typeof id === "string"))
      : null;
  } catch {
    return null;
  }
}

function persistHistory(key: string, currentIds: string[], previous: Set<string>): Set<string> {
  const ids = [...new Set([...currentIds, ...previous])].slice(0, HISTORY_LIMIT);
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // The in-memory copy below still prevents duplicates for this app session.
  }
  return new Set(ids);
}

/**
 * Delivers native notifications independently of the current desktop route.
 * Kiosk/board views do not mount the account sidebar, so desktop delivery must
 * live at the router root rather than inside the notification inbox UI.
 */
export function DesktopNotificationController() {
  const { slug } = useParams({ strict: false });

  useEffect(() => {
    if (!isDesktopRuntime() || !isDesktopMainWindow() || !slug) return;
    let active = true;
    let inFlight = false;
    let context: Awaited<ReturnType<typeof getOrgRouteContext>> | null = null;
    let memoryHistory: { key: string; ids: Set<string> } | null = null;

    const refresh = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        context ??= await getOrgRouteContext({ data: slug });
        if (!active || !context) return;
        const result = await getPersonalNotifications({ data: { orgId: context.org.id } });
        if (!active) return;

        const key = storageKey(context.user.id, context.org.id);
        const delivered = readHistory(key)
          ?? (memoryHistory?.key === key ? memoryHistory.ids : null);
        const accepted = delivered ?? new Set(result.notifications.map((item) => item.id));
        if (delivered) {
          for (const item of [...result.notifications].reverse()) {
            if (item.readAt) {
              accepted.add(item.id);
            } else if (!accepted.has(item.id)) {
              const shown = await showDesktopNotification(item.title, item.message, {
                notificationId: item.id,
                actionUrl: item.actionUrl,
                orgSlug: slug,
              });
              // Do not consume a notification while native permission is off.
              // It will be retried after the operator enables notifications.
              if (shown) accepted.add(item.id);
            }
          }
        }
        memoryHistory = {
          key,
          ids: persistHistory(
            key,
            result.notifications
              .filter((item) => accepted.has(item.id))
              .map((item) => item.id),
            accepted,
          ),
        };
      } catch {
        // Desktop navigation and local device control must survive inbox outages.
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener(DESKTOP_NOTIFICATION_POLL_EVENT, refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(DESKTOP_NOTIFICATION_POLL_EVENT, refresh);
    };
  }, [slug]);

  useEffect(() => {
    if (!isDesktopRuntime() || !isDesktopMainWindow()) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void listenForDesktopNotificationActions((payload) => {
      const path = payload.actionUrl
        ? getNotificationPath(payload.orgSlug, payload.actionUrl)
        : payload.orgSlug.length <= 64 && /^[a-zA-Z0-9-]+$/.test(payload.orgSlug)
          ? `/${payload.orgSlug}`
          : null;
      if (!path) return;
      void focusDesktopMainWindow().finally(() => {
        window.location.assign(path);
      });
    }).then((removeListener) => {
      if (active) unlisten = removeListener;
      else removeListener();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return null;
}
