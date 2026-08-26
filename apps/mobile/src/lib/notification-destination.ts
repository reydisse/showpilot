import { router, type Href } from "expo-router";
import { notificationRoute } from "@/lib/notification-route";

export function notificationHref(actionUrl: string): Href | null {
  const route = notificationRoute(actionUrl);
  if (!route) return null;
  if (route.screen === "devices") return "/devices";
  if (route.screen === "incidents") return "/incidents";
  if (route.screen === "schedule") return "/schedule";
  if (route.screen === "chat") return { pathname: "/chat", params: { room: route.room } };
  return { pathname: "/show/[showId]", params: { showId: route.showId } };
}

export function openNotificationDestination(actionUrl: unknown) {
  const destination = typeof actionUrl === "string" ? notificationHref(actionUrl) : null;
  router.push(destination ?? "/inbox");
}
