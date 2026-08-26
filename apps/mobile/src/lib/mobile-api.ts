import { z } from "zod";
import { fetch as expoFetch, type FetchRequestInit } from "expo/fetch";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { getAuthenticatedFetchCredentials, getNativeCookieHeader } from "@/lib/auth-transport";
import { SHOWPILOT_URL } from "@/lib/env";

const managedAvatarPath = /^\/api\/user\/avatar\/[^/?#]+\.jpg$/;

export function resolveMobileAvatarUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  if (candidate.startsWith("/")) {
    const parsed = new URL(candidate, SHOWPILOT_URL);
    return managedAvatarPath.test(parsed.pathname)
      ? `${SHOWPILOT_URL}${parsed.pathname}${parsed.search}`
      : null;
  }

  try {
    const parsed = new URL(candidate);
    if (managedAvatarPath.test(parsed.pathname)) {
      return `${SHOWPILOT_URL}${parsed.pathname}${parsed.search}`;
    }
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const avatarUploadSchema = z.object({
  url: z.string().refine((value) => resolveMobileAvatarUrl(value) !== null, "Invalid avatar URL"),
});

const rundownSchema = z.object({
  id: z.string(),
  serviceDate: z.string(),
  name: z.string(),
  scheduledStartTime: z.string().nullable(),
  location: z.string(),
  status: z.string(),
  itemCount: z.number(),
});

const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  title: z.string(),
  message: z.string(),
  actionUrl: z.string(),
  source: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});

export const bootstrapSchema = z.object({
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  timeZone: z.string().min(1),
  identity: z.object({ userId: z.string(), name: z.string(), role: z.string(), permissions: z.array(z.string()) }),
  shows: z.array(rundownSchema),
  notifications: z.array(notificationSchema),
  unreadNotifications: z.number(),
});

export type MobileBootstrap = z.infer<typeof bootstrapSchema>;

export const rundownItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  duration: z.number(),
  notes: z.string(),
  assignee: z.string(),
  cue: z.string(),
  status: z.string(),
  sortOrder: z.number(),
  hardStop: z.boolean(),
  lowerThirdId: z.string().optional(),
  actualStart: z.string().nullable().optional(),
  actualEnd: z.string().nullable().optional(),
});

export const timerSchema = z.object({
  playback: z.enum(["stop", "play", "pause"]).default("stop"),
  currentItemId: z.string().nullable().default(null),
  elapsed: z.number().default(0),
  startedAt: z.number().nullable().default(null),
  pausedAt: z.number().nullable().default(null),
  mode: z.enum(["count-down", "count-up", "clock"]).default("count-down"),
  serverTime: z.number().optional(),
});

export const mobileRundownSchema = z.object({
  show: rundownSchema.omit({ itemCount: true }),
  canControl: z.boolean(),
  items: z.array(rundownItemSchema),
  timer: timerSchema,
});

export type MobileRundown = z.infer<typeof mobileRundownSchema>;
export type RundownItem = z.infer<typeof rundownItemSchema>;
export type RundownTimer = z.infer<typeof timerSchema>;

const createMobileRundownResponseSchema = z.object({
  ok: z.literal(true),
  showId: z.string(),
  serviceDate: z.string(),
});

const scheduleSchema = z.object({
  from: z.string(),
  to: z.string(),
  timeZone: z.string().min(1),
  canViewFull: z.boolean(),
  canManage: z.boolean(),
  services: z.array(rundownSchema.extend({
    completedItems: z.number(),
    crewTotal: z.number(),
    crewConfirmed: z.number(),
    crewOpen: z.number(),
    incidentCount: z.number(),
  })),
  assignments: z.array(z.object({
    id: z.string(),
    showId: z.string().nullable(),
    serviceDate: z.string(),
    role: z.string(),
    department: z.string(),
    status: z.string(),
    callTime: z.string(),
    notes: z.string(),
    responseNote: z.string(),
    crewName: z.string().nullable(),
    crewEmail: z.string().nullable(),
    canRespond: z.boolean(),
    responseWindow: z.discriminatedUnion("status", [
      z.object({ status: z.literal("open"), closesAt: z.string().datetime() }),
      z.object({ status: z.literal("closed"), closedAt: z.string().datetime().nullable() }),
    ]),
  })),
});

const incidentSchema = z.object({
  id: z.string(),
  showId: z.string().nullable(),
  category: z.string(),
  severity: z.string(),
  description: z.string(),
  reportedBy: z.string(),
  serviceDate: z.string(),
  timestamp: z.string(),
  status: z.string(),
  assignedName: z.string(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});

const incidentsSchema = z.object({
  canReport: z.boolean(),
  canManage: z.boolean(),
  incidents: z.array(incidentSchema),
});

const mobileDeviceActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  params: z.array(z.object({
    id: z.string(),
    label: z.string(),
    type: z.enum(["number", "boolean"]),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    default: z.union([z.number(), z.boolean()]).optional(),
  })),
});

const devicesSchema = z.object({
  devices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    category: z.string(),
    adapterType: z.string(),
    enabled: z.boolean(),
    updatedAt: z.string(),
    controls: z.array(mobileDeviceActionSchema),
  })),
});

export type MobileSchedule = z.infer<typeof scheduleSchema>;
export type MobileIncident = z.infer<typeof incidentSchema>;
export type MobileIncidents = z.infer<typeof incidentsSchema>;
export type MobileDevices = z.infer<typeof devicesSchema>;
export type MobileDevice = MobileDevices["devices"][number];
export type MobileDeviceAction = z.infer<typeof mobileDeviceActionSchema>;

async function authenticatedFetch(path: string, init?: FetchRequestInit) {
  const response = await expoFetch(`${SHOWPILOT_URL}${path}`, {
    ...init,
    credentials: getAuthenticatedFetchCredentials() ?? init?.credentials,
    headers: {
      Accept: "application/json",
      ...(typeof init?.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...getNativeCookieHeader(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    let apiError = "";
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
        apiError = parsed.error.trim();
      }
    } catch {}
    if (apiError) throw new Error(apiError);
    throw new Error(body || `ShowPilot request failed (${response.status})`);
  }
  return response;
}

export async function uploadMobileAvatar(uri: string) {
  const form = new FormData();
  if (Platform.OS === "web") {
    const fileResponse = await expoFetch(uri);
    if (!fileResponse.ok) throw new Error("The selected photo could not be opened.");
    const image = await fileResponse.blob();
    if (image.size === 0) throw new Error("The selected photo is empty.");
    if (image.type !== "image/jpeg") throw new Error("The prepared profile photo is not a JPEG image.");
    form.append("file", image, "avatar.jpg");
  } else {
    const image = new File(uri);
    if (!image.exists || image.size === 0) throw new Error("The selected photo could not be opened.");
    if (image.type !== "image/jpeg") throw new Error("The prepared profile photo is not a JPEG image.");
    form.append("file", image);
  }
  const response = await authenticatedFetch("/api/user/avatar", { method: "POST", body: form });
  return avatarUploadSchema.parse(await response.json());
}

export async function getMobileBootstrap(orgId: string): Promise<MobileBootstrap> {
  const response = await authenticatedFetch(`/api/mobile/v1/bootstrap?orgId=${encodeURIComponent(orgId)}`);
  return bootstrapSchema.parse(await response.json());
}

export async function getMobileRundown(orgId: string, showId: string): Promise<MobileRundown> {
  const response = await authenticatedFetch(
    `/api/mobile/v1/rundowns/${encodeURIComponent(showId)}?orgId=${encodeURIComponent(orgId)}`,
  );
  return mobileRundownSchema.parse(await response.json());
}

export async function createMobileRundown(input: {
  orgId: string;
  serviceDate: string;
  name?: string;
  startTime?: string;
  location?: string;
}) {
  const response = await authenticatedFetch("/api/mobile/v1/rundowns", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return createMobileRundownResponseSchema.parse(await response.json());
}

export async function getMobileSchedule(
  orgId: string,
  selection: { serviceDate?: string; assignmentId?: string } = {},
): Promise<MobileSchedule> {
  const query = new URLSearchParams({ orgId });
  if (selection.serviceDate) query.set("date", selection.serviceDate);
  if (selection.assignmentId) query.set("assignment", selection.assignmentId);
  const response = await authenticatedFetch(`/api/mobile/v1/schedule?${query}`);
  return scheduleSchema.parse(await response.json());
}

export async function respondToMobileAssignment(input: {
  orgId: string;
  assignmentId: string;
  response: "confirmed" | "declined";
  reason?: string;
}) {
  await authenticatedFetch("/api/mobile/v1/schedule/respond", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getMobileIncidents(orgId: string): Promise<MobileIncidents> {
  const response = await authenticatedFetch(`/api/mobile/v1/incidents?orgId=${encodeURIComponent(orgId)}`);
  return incidentsSchema.parse(await response.json());
}

export async function reportMobileIncident(input: {
  orgId: string;
  showId?: string | null;
  category: "audio" | "video" | "stream" | "lighting" | "other";
  severity: "low" | "medium" | "high";
  description: string;
  serviceDate: string;
}) {
  await authenticatedFetch(`/api/mobile/v1/incidents?orgId=${encodeURIComponent(input.orgId)}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getMobileDevices(orgId: string): Promise<MobileDevices> {
  const response = await authenticatedFetch(`/api/mobile/v1/devices?orgId=${encodeURIComponent(orgId)}`);
  return devicesSchema.parse(await response.json());
}

export async function controlMobileDevice(input: {
  orgId: string;
  deviceId: string;
  operation: "connect" | "disconnect" | "action";
  actionId?: string;
  params?: Record<string, number | boolean>;
}) {
  const response = await authenticatedFetch(
    `/api/mobile/v1/devices/${encodeURIComponent(input.deviceId)}/control?orgId=${encodeURIComponent(input.orgId)}`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return z.object({ success: z.literal(true), response: z.string().optional() }).parse(await response.json());
}

export async function markNotificationRead(orgId: string, notificationId: string) {
  await authenticatedFetch("/api/mobile/v1/notifications/read", {
    method: "POST",
    body: JSON.stringify({ orgId, notificationId }),
  });
}

export async function markAllNotificationsRead(orgId: string) {
  await authenticatedFetch("/api/mobile/v1/notifications/read", {
    method: "POST",
    body: JSON.stringify({ orgId, all: true }),
  });
}

export async function saveMobilePushToken(
  orgId: string,
  token: string,
  platform: "ios" | "android",
  enabled = true,
) {
  await authenticatedFetch("/api/mobile/v1/push-token", {
    method: "POST",
    body: JSON.stringify({ orgId, token, platform, enabled }),
  });
}
