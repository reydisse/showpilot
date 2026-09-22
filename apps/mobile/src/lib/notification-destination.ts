import { router, type Href } from "expo-router";
import { notificationRoute } from "@/lib/notification-route";

export function notificationHref(actionUrl: string): Href | null {
  const route = notificationRoute(actionUrl);
  if (!route) return null;
  if (route.screen === "devices") return "/devices";
  if (route.screen === "incidents") return {
    pathname: "/incidents",
    params: {
      ...(route.date ? { date: route.date } : {}),
      ...(route.showId ? { show: route.showId } : {}),
      ...(route.incidentId ? { incident: route.incidentId } : {}),
    },
  };
  if (route.screen === "reports") return {
    pathname: "/reports",
    params: {
      ...(route.date ? { date: route.date } : {}),
      ...(route.showId ? { show: route.showId } : {}),
    },
  };
  if (route.screen === "operations") return "/operations";
  if (route.screen === "checklist") {
    return route.showId
      ? { pathname: "/checklist", params: { showId: route.showId } }
      : "/checklist";
  }
  if (route.screen === "checkin") return "/checkin";
  if (route.screen === "shows") return "/shows";
  if (route.screen === "schedule") {
    return {
      pathname: "/schedule",
      params: {
        ...(route.date ? { date: route.date } : {}),
        ...(route.assignmentId ? { assignment: route.assignmentId } : {}),
      },
    };
  }
  if (route.screen === "chat") return {
    pathname: "/chat",
    params: { room: route.room, ...(route.messageId ? { message: route.messageId } : {}) },
  };
  return { pathname: "/show/[showId]", params: { showId: route.showId } };
}

export function openNotificationDestination(actionUrl: unknown) {
  const destination = typeof actionUrl === "string" ? notificationHref(actionUrl) : null;
  router.push(destination ?? "/inbox");
}
