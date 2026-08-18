export type NotificationDestination =
  | { kind: "tech-manager" }
  | { kind: "incident"; incident?: string; date?: string }
  | { kind: "schedule"; date?: string; assignment?: string }
  | { kind: "chat"; room: string };

/** Resolve only the internal destinations notifications are allowed to open. */
export function getNotificationDestination(actionUrl: string): NotificationDestination | null {
  if (actionUrl === "dashboard/tech-manager") return { kind: "tech-manager" };

  if (actionUrl === "production/incidents" || actionUrl.startsWith("production/incidents?")) {
    const search = actionUrl.includes("?")
      ? new URLSearchParams(actionUrl.slice(actionUrl.indexOf("?") + 1))
      : null;
    return {
      kind: "incident",
      incident: search?.get("incident")?.trim() || undefined,
      date: search?.get("date")?.trim() || undefined,
    };
  }

  if (actionUrl === "schedule" || actionUrl.startsWith("schedule?")) {
    const search = actionUrl.includes("?") ? new URLSearchParams(actionUrl.slice(actionUrl.indexOf("?") + 1)) : null;
    return { kind: "schedule", date: search?.get("date") || undefined, assignment: search?.get("assignment") || undefined };
  }

  if (actionUrl.startsWith("chat?")) {
    const room = new URLSearchParams(actionUrl.slice(actionUrl.indexOf("?") + 1)).get("room");
    const isKnownRoom = room === "production" || room === "planning";
    const dmParts = room?.split(":") ?? [];
    const isDmRoom = dmParts.length === 3 && dmParts[0] === "dm" && Boolean(dmParts[1]) && dmParts[1] < dmParts[2];
    if (room && (isKnownRoom || isDmRoom)) return { kind: "chat", room };
  }

  return null;
}
