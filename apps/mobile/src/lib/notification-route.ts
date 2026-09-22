import { isServiceDate } from "./service-time";

export type MobileNotificationRoute =
  | { screen: "devices" }
  | { screen: "incidents"; date?: string; showId?: string; incidentId?: string }
  | { screen: "reports"; date?: string; showId?: string }
  | { screen: "operations" }
  | { screen: "checklist"; showId?: string }
  | { screen: "checkin" }
  | { screen: "shows" }
  | { screen: "schedule"; date?: string; assignmentId?: string }
  | { screen: "chat"; room: string; messageId?: string }
  | { screen: "show"; showId: string };

function internalPath(value: string) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== "showpilot.tech" && !url.hostname.endsWith(".showpilot.tech")) return "";
      return `${url.pathname.replace(/^\/+/, "")}${url.search}`;
    } catch {
      return "";
    }
  }
  return trimmed.replace(/^\/+/, "");
}

function withoutOrganizationPrefix(path: string) {
  const separator = path.indexOf("?");
  const pathname = separator < 0 ? path : path.slice(0, separator);
  const search = separator < 0 ? "" : path.slice(separator);
  const segments = pathname.split("/").filter(Boolean);
  const knownRoots = new Set(["dashboard", "production", "schedule", "assignments", "chat", "rundown", "show", "board", "checkin", "timecode", "streaming"]);
  if (segments.length > 1 && !knownRoots.has(segments[0]) && knownRoots.has(segments[1])) {
    return `${segments.slice(1).join("/")}${search}`;
  }
  return path;
}

function searchFor(path: string) {
  const separator = path.indexOf("?");
  return separator < 0 ? new URLSearchParams() : new URLSearchParams(path.slice(separator + 1));
}

export function notificationRoute(actionUrl: string): MobileNotificationRoute | null {
  const path = withoutOrganizationPrefix(internalPath(actionUrl));
  if (path === "dashboard/tech-manager" || path.startsWith("dashboard/devices")) return { screen: "devices" };
  if (path === "rundown" || path === "board") return { screen: "shows" };
  if (path === "production/checklist" || path.startsWith("production/checklist?")) {
    const showId = searchFor(path).get("show") || searchFor(path).get("showId");
    return { screen: "checklist", ...(showId ? { showId } : {}) };
  }
  if (path === "checkin") return { screen: "checkin" };
  if (
    path === "production/cue-sheets"
    || path === "timecode"
    || path === "streaming/graphics"
    || path === "streaming/health"
    || path === "production/assets"
    || path === "dashboard/prod-manager"
  ) return { screen: "operations" };
  if (path === "production/incidents" || path.startsWith("production/incidents?")) {
    const search = searchFor(path);
    const date = search.get("date");
    const showId = search.get("show");
    const incidentId = search.get("incident");
    return {
      screen: "incidents",
      ...(isServiceDate(date) ? { date } : {}),
      ...(showId ? { showId } : {}),
      ...(incidentId ? { incidentId } : {}),
    };
  }
  if (path === "reports" || path.startsWith("reports?")) {
    const search = searchFor(path);
    const date = search.get("date");
    const showId = search.get("show");
    return {
      screen: "reports",
      ...(isServiceDate(date) ? { date } : {}),
      ...(showId ? { showId } : {}),
    };
  }
  if (
    path === "schedule" ||
    path.startsWith("schedule?") ||
    path === "assignments" ||
    path.startsWith("assignments?")
  ) {
    const search = searchFor(path);
    const date = search.get("date");
    const assignmentId = search.get("assignment");
    return {
      screen: "schedule",
      ...(isServiceDate(date) ? { date } : {}),
      ...(assignmentId && assignmentId.length <= 128 ? { assignmentId } : {}),
    };
  }
  if (path === "chat" || path.startsWith("chat?")) {
    const search = searchFor(path);
    const room = search.get("room") || "production";
    const messageId = search.get("message");
    const parts = room.split(":");
    const validRoom = room === "production" || room === "planning"
      || (parts.length === 3 && parts[0] === "dm" && Boolean(parts[1]) && parts[1] < parts[2]);
    return validRoom ? { screen: "chat", room, ...(messageId ? { messageId } : {}) } : null;
  }
  if (path.startsWith("rundown?") || path === "show" || path.startsWith("show?")) {
    const showId = searchFor(path).get("show") || searchFor(path).get("showId");
    return showId ? { screen: "show", showId } : null;
  }
  return null;
}
