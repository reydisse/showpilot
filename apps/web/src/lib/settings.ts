import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import {
  hasAnyPermission,
  hasPermission,
  isAdminTier,
  normalizeRole,
  type Permission,
} from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { getTodayDateString } from "@/lib/utils";
import { assertOrgPermission as assertEffectiveOrgPermission } from "@/lib/org-access";
import { readMemberVisibleOrgSettings } from "@/lib/settings-read.server";
import { getD1 } from "@/lib/d1";
import {
  appendWebhookEvent,
  MAX_WEBHOOK_EVENTS,
  normalizeWebhookEvent,
  WEBHOOK_EVENTS_KEY,
  type WebhookEventLogItem,
} from "@/lib/webhook-events";
import { hashRundownPin } from "@/lib/rundown-pin-crypto";
import { RUNDOWN_PIN_SETTING_KEY } from "@/lib/rundown-pin";

export { appendWebhookEvent, sanitizePayloadSummary } from "@/lib/webhook-events";
export type { WebhookEventInput, WebhookEventLogItem } from "@/lib/webhook-events";

// AppSetting values can be JSON blobs (templates, rundown snapshots) —
// bound generously but finitely.
const settingKeySchema = z.string().min(1).max(100);
const settingValueSchema = z.string().max(200_000);
const genericSettingKeySchema = settingKeySchema.refine(
  (key) => key !== RUNDOWN_PIN_SETTING_KEY,
  "Use the dedicated rundown PIN control.",
);
const rundownPinSchema = z.string().regex(/^\d{4,8}$/u, "PIN must contain 4 to 8 digits.");
const rundownPinUpdateSchema = z.discriminatedUnion("action", [
  z.object({ orgId: idSchema, action: z.literal("set"), pin: rundownPinSchema }),
  z.object({ orgId: idSchema, action: z.literal("disable") }),
]);

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

// Plan gating: configuring an integration requires a plan that includes
// integrations. Clearing a value or reverting an adapter to "native" is
// always allowed so downgraded orgs can untangle themselves.
async function assertIntegrationPlanAllows(orgId: string, key: string, value: string) {
  if (permissionForSettingKey(key) !== "settings:integrations") return;
  if (!value || value === "native") return;
  const { requirePlanFeature } = await import("@/lib/plan-limits");
  await requirePlanFeature(orgId, "integrations");
}

function permissionForSettingKey(key: string): Permission {
  if (key === "api-key") return "settings:api_keys";
  if (key === "webhook-url") return "settings:webhooks";
  if (key.startsWith("notify-")) return "settings:notifications";
  if (key.startsWith("l3-")) return "settings:lowerthird_config";
  if (
    key === "chat-adapter" ||
    key === "rundown-adapter" ||
    key === "lyrics-output" ||
    key.startsWith("slack-") ||
    key.startsWith("mattermost-") ||
    key.startsWith("teams-") ||
    key.startsWith("discord-") ||
    key.startsWith("ontime-") ||
    key.startsWith("propresenter-") ||
    key.startsWith("pco-") ||
    key.startsWith("schedule-")
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

/** Operational defaults that are safe for every organization member. */
export const getOrgSettings = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    return readMemberVisibleOrgSettings(getD1(), data.orgId);
  });

/** Settings visible to the current member's settings permissions. */
export const getManageableOrgSettings = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const role = await getOrgMemberRole(data.orgId);
    const settings = await getPrisma().appSetting.findMany({
      where: { orgId: data.orgId },
      select: { key: true, value: true },
    });
    return Object.fromEntries(
      settings
        .filter((setting) => setting.key !== RUNDOWN_PIN_SETTING_KEY)
        .filter((setting) => hasPermission(role, permissionForSettingKey(setting.key)))
        .map((setting) => [setting.key, setting.value]),
    );
  });

export const updateRundownPinProtection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(rundownPinUpdateSchema, data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    if (data.action === "disable") {
      await prisma.appSetting.deleteMany({
        where: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY },
      });
      return { enabled: false as const };
    }

    const value = await hashRundownPin(data.pin);
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY } },
      update: { value },
      create: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY, value },
    });
    return { enabled: true as const };
  });

const PROPRESENTER_RUNTIME_SETTING_KEYS = [
  "propresenter-host",
  "propresenter-port",
  "propresenter-api-port",
  "propresenter-password",
  "propresenter-send-cues",
  "propresenter-stage-display",
] as const;

const DESKTOP_BRIDGE_SETTING_KEYS = [
  "api-key",
  ...PROPRESENTER_RUNTIME_SETTING_KEYS,
] as const;

/** Native ProPresenter credentials for authorized live-show operators. */
export const getProPresenterRuntimeSettings = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertEffectiveOrgPermission(data.orgId, ["lowerthird:trigger", "rundown:control"]);
    const settings = await getPrisma().appSetting.findMany({
      where: {
        orgId: data.orgId,
        key: { in: [...PROPRESENTER_RUNTIME_SETTING_KEYS] },
      },
      select: { key: true, value: true },
    });
    return Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
  });

/** Returns native device credentials only to members allowed to manage API keys. */
export const getDesktopBridgeSettings = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:api_keys");
    const settings = await getPrisma().appSetting.findMany({
      where: {
        orgId: data.orgId,
        key: { in: [...DESKTOP_BRIDGE_SETTING_KEYS] },
      },
      select: { key: true, value: true },
    });
    return Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
  });

export const updateOrgSetting = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ orgId: idSchema, key: genericSettingKeySchema, value: settingValueSchema }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, permissionForSettingKey(data.key));
    await assertIntegrationPlanAllows(data.orgId, data.key, data.value);
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
          .array(z.object({ key: genericSettingKeySchema, value: settingValueSchema }))
          .max(100),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    for (const setting of data.settings) {
      await assertOrgPermission(data.orgId, permissionForSettingKey(setting.key));
      await assertIntegrationPlanAllows(data.orgId, setting.key, setting.value);
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
    const random = new Uint8Array(40);
    crypto.getRandomValues(random);
    const key =
      "sp_" + Array.from(random, (value) => chars[value % chars.length]).join("");
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
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }): Promise<ActiveAdapters> => {
    await assertEffectiveOrgPermission(data.orgId, ["show:view", "chat:access"]);
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
  activeServiceDate: string;
  activeShowId: string;
  rundownServiceDate: string;
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
        activeServiceDate: "",
        activeShowId: "",
        rundownServiceDate: getTodayDateString(),
      };
    }

    const [settings, shows] = await Promise.all([
      prisma.appSetting.findMany({
        where: {
          orgId: org.id,
          key: { in: [
            "clock-format",
            "timezone-display",
            "org-timezone",
            "overtime-behavior",
            "default-timer-mode",
            "default-countdown-minutes",
            "active-service-date",
            "active-show-id",
          ] },
        },
      }),
      prisma.rundown.findMany({
        where: { orgId: org.id },
        orderBy: [
          { serviceDate: "asc" },
          { scheduledStartTime: "asc" },
          { createdAt: "asc" },
        ],
        select: { id: true, serviceDate: true },
      }),
    ]);

    const map: Record<string, string> = {};
    for (const setting of settings) map[setting.key] = setting.value;

    const today = getTodayDateString(map["org-timezone"] || undefined);
    const selectedShow =
      shows.find((show) => show.id === map["active-show-id"]) ??
      shows.find((show) => show.serviceDate === map["active-service-date"]) ??
      shows.find((show) => show.serviceDate >= today) ??
      shows.at(-1);

    return {
      clockFormat: (map["clock-format"] as "12hr" | "24hr") || "12hr",
      timezoneDisplay: (map["timezone-display"] as "local" | "org" | "utc") || "local",
      orgTimezone: map["org-timezone"] || "",
      overtimeBehavior: (map["overtime-behavior"] as "flash" | "countup" | "stop") || "flash",
      defaultTimerMode: (map["default-timer-mode"] as "countdown" | "countup" | "clock") || "countdown",
      defaultCountdownMinutes: Number(map["default-countdown-minutes"] || "5") || 5,
      activeServiceDate: map["active-service-date"] || "",
      activeShowId: selectedShow?.id ?? "",
      rundownServiceDate: selectedShow?.serviceDate ?? today,
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

// Cloud lower thirds feature flag (organization.cloud_enabled). Owner/admin
// only — this is an org-wide feature/cost switch, not a per-operator setting.
// See SHOWPILOT-FIXES-SPEC Task A2. The middleware (withPermission) reads this
// column to decide whether lowerthird:* routes are reachable.
export const setCloudEnabled = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, enabled: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    const role = await getOrgMemberRole(data.orgId);
    if (!isAdminTier(role)) throw new Error("Forbidden");

    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: data.orgId },
      data: { cloud_enabled: data.enabled },
    });
    return { ok: true as const, cloudEnabled: data.enabled };
  });
