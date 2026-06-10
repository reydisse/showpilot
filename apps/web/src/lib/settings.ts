import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import {
  hasAnyPermission,
  hasPermission,
  normalizeRole,
  type Permission,
} from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";

// AppSetting values can be JSON blobs (templates, rundown snapshots) —
// bound generously but finitely.
const settingKeySchema = z.string().min(1).max(100);
const settingValueSchema = z.string().max(200_000);

async function getOrgMemberRole(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role) throw new Error("Forbidden");
  return role;
}

async function assertOrgAccess(orgId: string) {
  await getOrgMemberRole(orgId);
}

async function assertOrgPermission(orgId: string, permission: Permission) {
  const role = await getOrgMemberRole(orgId);
  if (!hasPermission(role, permission)) throw new Error("Forbidden");
}

async function assertApiOrWebhookPermission(orgId: string) {
  const role = await getOrgMemberRole(orgId);
  if (!hasAnyPermission(role, ["settings:api_keys", "settings:webhooks"])) {
    throw new Error("Forbidden");
  }
}

const WEBHOOK_EVENTS_KEY = "webhook-events";
const MAX_WEBHOOK_EVENTS = 50;

interface StoredWebhookEvent {
  id?: string;
  timestamp?: string;
  source?: string;
  type?: string;
  direction?: "incoming" | "outgoing" | "system";
  status?: "success" | "error" | "info" | "warning";
  details?: string;
  payloadSummary?: string;
}

export interface WebhookEventLogItem {
  id: string;
  timestamp: string;
  source: string;
  type: string;
  direction: "incoming" | "outgoing" | "system";
  status: "success" | "error" | "info" | "warning";
  details: string;
  payloadSummary?: string;
}

export interface WebhookEventInput
  extends Omit<WebhookEventLogItem, "id" | "timestamp"> {}

export function sanitizePayloadSummary(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    if (!payload.trim()) return undefined;
    return payload.length > 180 ? `${payload.slice(0, 177)}...` : payload;
  }

  if (payload == null) return undefined;

  try {
    const json = JSON.stringify(payload);
    if (!json) return undefined;
    return json.length > 180 ? `${json.slice(0, 177)}...` : json;
  } catch {
    return undefined;
  }
}

function normalizeWebhookEvent(raw: unknown, fallbackIndex: number): WebhookEventLogItem | null {
  const event = raw as StoredWebhookEvent | null;
  if (!event || typeof event !== "object") return null;

  const direction =
    event.direction === "incoming" || event.direction === "outgoing" || event.direction === "system"
      ? event.direction
      : "system";
  const status =
    event.status === "success" || event.status === "error" || event.status === "warning"
      ? event.status
      : "info";
  const timestamp =
    typeof event.timestamp === "string" && !Number.isNaN(Date.parse(event.timestamp))
      ? event.timestamp
      : new Date().toISOString();

  return {
    id:
      event.id && event.id.length > 0
        ? event.id
        : `webhook-event-${Date.now()}-${fallbackIndex}`,
    timestamp,
    source: event.source && event.source.trim().length > 0 ? event.source : "system",
    type: event.type && event.type.trim().length > 0 ? event.type : "webhook-event",
    direction,
    status,
    details: event.details?.trim() ? event.details : "No details provided.",
    payloadSummary:
      event.payloadSummary || sanitizePayloadSummary((event as Record<string, unknown>).payload),
  };
}

export async function appendWebhookEvent(
  prisma: ReturnType<typeof getPrisma>,
  orgId: string,
  event: WebhookEventInput,
) {
  const existing = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: WEBHOOK_EVENTS_KEY } },
  });

  const parsed = existing?.value ? (() => {
    try {
      return JSON.parse(existing.value);
    } catch {
      return [];
    }
  })() : [];

  const previousEvents = Array.isArray(parsed) ? (parsed as unknown[]) : [];
  const normalizedEvents = previousEvents
    .map((entry, index) => normalizeWebhookEvent(entry, index))
    .filter((entry): entry is WebhookEventLogItem => Boolean(entry));

  const nextEvents: WebhookEventLogItem[] = [
    {
      ...event,
      id: `webhook-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    },
    ...normalizedEvents,
  ];

  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key: WEBHOOK_EVENTS_KEY } },
    update: { value: JSON.stringify(nextEvents.slice(0, MAX_WEBHOOK_EVENTS)) },
    create: { orgId, key: WEBHOOK_EVENTS_KEY, value: JSON.stringify(nextEvents.slice(0, MAX_WEBHOOK_EVENTS)) },
  });
}

function permissionForSettingKey(key: string): Permission {
  if (key === "api-key") return "settings:api_keys";
  if (key === "webhook-url") return "settings:webhooks";
  if (key.startsWith("notify-")) return "settings:notifications";
  if (key.startsWith("l3-")) return "settings:lowerthird_config";
  if (
    key === "chat-adapter" ||
    key === "rundown-adapter" ||
    key.startsWith("slack-") ||
    key.startsWith("mattermost-") ||
    key.startsWith("teams-") ||
    key.startsWith("discord-") ||
    key.startsWith("ontime-") ||
    key.startsWith("propresenter-") ||
    key.startsWith("pco-")
  ) {
    return "settings:integrations";
  }
  if (
    key.startsWith("default-") ||
    key === "clock-format" ||
    key === "timezone-display" ||
    key === "overtime-behavior"
  ) {
    return "settings:production_defaults";
  }
  if (key.startsWith("org-")) return "settings:organization";
  return "settings:organization";
}

// ─── Org Settings (AppSetting table) ────────────────────────

export const getOrgSettings = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    const settings = await prisma.appSetting.findMany({
      where: { orgId: data.orgId },
    });
    const map: Record<string, string> = {};
    for (const s of settings) {
      map[s.key] = s.value;
    }
    return map;
  });

export const updateOrgSetting = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, key: settingKeySchema, value: settingValueSchema }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, permissionForSettingKey(data.key));
    const prisma = getPrisma();
    const previousSetting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: data.key } },
      select: { value: true },
    });
    const result = await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: data.key } },
      update: { value: data.value },
      create: { orgId: data.orgId, key: data.key, value: data.value },
    });

    if (data.key === "webhook-url") {
      try {
        await appendWebhookEvent(prisma, data.orgId, {
          source: "settings",
          type: previousSetting?.value
            ? "webhook-url-updated"
            : "webhook-url-set",
          direction: "system",
          status: "info",
          details: data.value
            ? "Incoming webhook URL has been configured."
            : "Incoming webhook URL has been cleared.",
        });
      } catch {
        // Non-blocking telemetry
      }
    }

    return result;
  });

export const bulkUpdateOrgSettings = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        settings: z
          .array(z.object({ key: settingKeySchema, value: settingValueSchema }))
          .max(100),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    for (const setting of data.settings) {
      await assertOrgPermission(data.orgId, permissionForSettingKey(setting.key));
    }
    const prisma = getPrisma();
    const results = [];
    for (const s of data.settings) {
      const r = await prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key: s.key } },
        update: { value: s.value },
        create: { orgId: data.orgId, key: s.key, value: s.value },
      });
      results.push(r);
    }
    return results;
  });

export const getRecentWebhookEvents = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertApiOrWebhookPermission(data.orgId);
    const prisma = getPrisma();
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: WEBHOOK_EVENTS_KEY } },
    });

    if (!setting?.value) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(setting.value);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    return parsed
      .slice(0, MAX_WEBHOOK_EVENTS)
      .map((entry, index) => normalizeWebhookEvent(entry, index))
      .filter((event): event is WebhookEventLogItem => Boolean(event))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  });

// ─── Org Members ────────────────────────────────────────────

export const getOrgMembers = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    return await prisma.member.findMany({
      where: { organizationId: data.orgId },
      include: { user: true },
    });
  });

// ─── API Key ────────────────────────────────────────────────

export const regenerateApiKey = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:api_keys");
    const prisma = getPrisma();
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let key = "sp_";
    for (let i = 0; i < 40; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: "api-key" } },
      update: { value: key },
      create: { orgId: data.orgId, key: "api-key", value: key },
    });
    return key;
  });

// ─── Active Adapters ────────────────────────────────────────

export type RundownAdapterType = "native" | "ontime" | "propresenter" | "planning-center";
export type ChatAdapterType = "native" | "slack" | "mattermost" | "teams" | "discord";

export interface ActiveAdapters {
  rundown: RundownAdapterType;
  chat: ChatAdapterType;
}

/**
 * Resolve which adapters are active for an org.
 * Defaults to "native" for everything.
 */
export const getActiveAdapters = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<ActiveAdapters> => {
    const prisma = getPrisma();
    const settings = await prisma.appSetting.findMany({
      where: {
        orgId: data.orgId,
        key: { in: ["rundown-adapter", "chat-adapter"] },
      },
    });
    const map: Record<string, string> = {};
    for (const s of settings) {
      map[s.key] = s.value;
    }
    return {
      rundown: (map["rundown-adapter"] as RundownAdapterType) || "native",
      chat: (map["chat-adapter"] as ChatAdapterType) || "native",
    };
  });

// ─── Clock Format ────────────────────────────────────────────

export const getClockFormat = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<"12hr" | "24hr"> => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "clock-format" } },
    });
    return (setting?.value as "12hr" | "24hr") || "12hr";
  });

export const getClockFormatBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: { orgSlug: string }) => data)
  .handler(async ({ data }): Promise<"12hr" | "24hr"> => {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
    });
    if (!org) return "12hr";
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: org.id, key: "clock-format" } },
    });
    return (setting?.value as "12hr" | "24hr") || "12hr";
  });

export interface DisplaySettingsBySlug {
  clockFormat: "12hr" | "24hr";
  timezoneDisplay: "local" | "org" | "utc";
  orgTimezone: string;
  overtimeBehavior: "flash" | "countup" | "stop";
  defaultTimerMode: "countdown" | "countup" | "clock";
  defaultCountdownMinutes: number;
}

export const getDisplaySettingsBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: { orgSlug: string }) => data)
  .handler(async ({ data }): Promise<DisplaySettingsBySlug> => {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { slug: data.orgSlug } });
    if (!org) {
      return {
        clockFormat: "12hr",
        timezoneDisplay: "local",
        orgTimezone: "",
        overtimeBehavior: "flash",
        defaultTimerMode: "countdown",
        defaultCountdownMinutes: 5,
      };
    }

    const settings = await prisma.appSetting.findMany({
      where: {
        orgId: org.id,
        key: {
          in: [
            "clock-format",
            "timezone-display",
            "org-timezone",
            "overtime-behavior",
            "default-timer-mode",
            "default-countdown-minutes",
          ],
        },
      },
    });

    const map: Record<string, string> = {};
    for (const setting of settings) map[setting.key] = setting.value;

    return {
      clockFormat: (map["clock-format"] as "12hr" | "24hr") || "12hr",
      timezoneDisplay: (map["timezone-display"] as "local" | "org" | "utc") || "local",
      orgTimezone: map["org-timezone"] || "",
      overtimeBehavior: (map["overtime-behavior"] as "flash" | "countup" | "stop") || "flash",
      defaultTimerMode: (map["default-timer-mode"] as "countdown" | "countup" | "clock") || "countdown",
      defaultCountdownMinutes: Number(map["default-countdown-minutes"] || "5") || 5,
    };
  });

// ─── Danger Zone ────────────────────────────────────────────

export const deleteOrgSettings = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, keys: z.array(settingKeySchema).max(100) }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:danger_zone");
    const prisma = getPrisma();
    await prisma.appSetting.deleteMany({
      where: { orgId: data.orgId, key: { in: data.keys } },
    });
  });
