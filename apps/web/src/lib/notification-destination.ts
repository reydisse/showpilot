export type NotificationDestination =
  | { kind: "tech-manager" }
  | { kind: "incident"; incident?: string; date?: string; show?: string }
  | { kind: "schedule"; date?: string; assignment?: string }
  | { kind: "chat"; room: string; message?: string }
  | { kind: "feature"; path: NotificationFeaturePath };

export const NOTIFICATION_FEATURE_PATHS = [
  "rundown",
  "board",
  "production/cue-sheets",
  "production/checklist",
  "checkin",
  "timecode",
  "streaming/graphics",
  "streaming/health",
  "production/assets",
  "dashboard/prod-manager",
] as const;

export type NotificationFeaturePath = (typeof NOTIFICATION_FEATURE_PATHS)[number];

export type AccessGrantNotificationPath =
  | "schedule"
  | "production/incidents"
  | "dashboard/tech-manager"
  | NotificationFeaturePath;

function isNotificationFeaturePath(value: string): value is NotificationFeaturePath {
  return (NOTIFICATION_FEATURE_PATHS as readonly string[]).includes(value);
}

/** Resolve only the internal destinations notifications are allowed to open. */
export function getNotificationDestination(actionUrl: string): NotificationDestination | null {
  if (actionUrl === "dashboard/tech-manager") return { kind: "tech-manager" };
  if (isNotificationFeaturePath(actionUrl)) return { kind: "feature", path: actionUrl };

  if (actionUrl === "production/incidents" || actionUrl.startsWith("production/incidents?")) {
    const search = actionUrl.includes("?")
      ? new URLSearchParams(actionUrl.slice(actionUrl.indexOf("?") + 1))
      : null;
    return {
      kind: "incident",
      incident: search?.get("incident")?.trim() || undefined,
      date: search?.get("date")?.trim() || undefined,
      show: search?.get("show")?.trim() || undefined,
    };
  }

  if (actionUrl === "schedule" || actionUrl.startsWith("schedule?")) {
    const search = actionUrl.includes("?") ? new URLSearchParams(actionUrl.slice(actionUrl.indexOf("?") + 1)) : null;
    return { kind: "schedule", date: search?.get("date") || undefined, assignment: search?.get("assignment") || undefined };
  }

  if (actionUrl.startsWith("chat?")) {
    const search = new URLSearchParams(actionUrl.slice(actionUrl.indexOf("?") + 1));
    const room = search.get("room");
    const message = search.get("message")?.trim() || undefined;
    const isKnownRoom = room === "production" || room === "planning";
    const dmParts = room?.split(":") ?? [];
    const isDmRoom = dmParts.length === 3 && dmParts[0] === "dm" && Boolean(dmParts[1]) && dmParts[1] < dmParts[2];
    if (room && (isKnownRoom || isDmRoom)) return { kind: "chat", room, message };
  }

  return null;
}

export function getNotificationPath(orgSlug: string, actionUrl: string): string | null {
  if (
    !orgSlug
    || orgSlug.length > 64
    || !/^[a-zA-Z0-9-]+$/.test(orgSlug)
  ) {
    return null;
  }

  const destination = getNotificationDestination(actionUrl);
  if (!destination) return null;
  const base = `/${orgSlug}`;
  if (destination.kind === "tech-manager") return `${base}/dashboard/tech-manager`;

  const search = new URLSearchParams();
  if (destination.kind === "incident") {
    if (destination.incident) search.set("incident", destination.incident);
    if (destination.date) search.set("date", destination.date);
    if (destination.show) search.set("show", destination.show);
    return `${base}/production/incidents${search.size ? `?${search}` : ""}`;
  }
  if (destination.kind === "schedule") {
    if (destination.date) search.set("date", destination.date);
    if (destination.assignment) search.set("assignment", destination.assignment);
    return `${base}/schedule${search.size ? `?${search}` : ""}`;
  }
  if (destination.kind === "feature") return `${base}/${destination.path}`;

  search.set("room", destination.room);
  if (destination.message) search.set("message", destination.message);
  return `${base}/chat?${search}`;
}
