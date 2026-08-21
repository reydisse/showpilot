import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { isDesktopRuntime, showDesktopNotification } from "@/lib/desktop-runtime";
import { getPersonalNotifications } from "@/lib/personal-notifications";
import { getOrgRouteContext } from "@/lib/session";

const HISTORY_LIMIT = 120;
const NATIVE_POLL_EVENT = "showpilot-desktop-notification-poll";

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
    if (!isDesktopRuntime() || !slug) return;
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
        if (delivered) {
          for (const item of [...result.notifications].reverse()) {
            if (!item.readAt && !delivered.has(item.id)) {
              await showDesktopNotification(item.title, item.message, {
                notificationId: item.id,
                actionUrl: item.actionUrl,
                orgSlug: slug,
              });
            }
          }
        }
        memoryHistory = {
          key,
          ids: persistHistory(key, result.notifications.map((item) => item.id), delivered ?? new Set()),
        };
      } catch {
        // Desktop navigation and local device control must survive inbox outages.
      } finally {
        inFlight = false;
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener(NATIVE_POLL_EVENT, refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(NATIVE_POLL_EVENT, refresh);
    };
  }, [slug]);

  return null;
}
