import { router, type Href } from "expo-router";
import { notificationRoute } from "@/lib/notification-route";

export function notificationHref(actionUrl: string): Href | null {
  const route = notificationRoute(actionUrl);
  if (!route) return null;
  if (route.screen === "devices") return "/devices" as Href;
  if (route.screen === "incidents") return "/incidents" as Href;
  if (route.screen === "schedule") return "/schedule" as Href;
  if (route.screen === "chat") return { pathname: "/chat", params: { room: route.room } } as unknown as Href;
  return { pathname: "/show/[showId]", params: { showId: route.showId } } as unknown as Href;
}

export function openNotificationDestination(actionUrl: unknown) {
  const destination = typeof actionUrl === "string" ? notificationHref(actionUrl) : null;
  router.push(destination ?? "/inbox");
}
