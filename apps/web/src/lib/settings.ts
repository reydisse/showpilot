import { encryptSettingValue, maskSettingValue } from "./credential-settings.server";
import { CREDENTIAL_MASK, isCredentialField } from "./credential-fields";
import { EDITABLE_SETTING_KEYS, isEditableSettingKey, permissionForSettingKey, genericSettingKeySchema } from "./editable-settings";
import { settingWriteSchema } from "./setting-writes";
import { applySettingWrite } from "./setting-writes.server";
import { CONFIDENCE_LAYOUT_KEY, confidenceLayoutSchema, readConfidenceLayout, DEFAULT_CONFIDENCE_LAYOUT, type ConfidenceLayout } from "@/lib/confidence-layout";
import { createServerFn } from "@tanstack/react-start";
import { getRequest, getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { requireDisplayAccess } from "./display-access.server";
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
import { refreshOrgReadAuthority } from "./relay-read-invalidation.server";

export { appendWebhookEvent, sanitizePayloadSummary } from "@/lib/webhook-events";
export type { WebhookEventInput, WebhookEventLogItem } from "@/lib/webhook-events";

// Editable values include the confidence layout JSON; internal application
// records in app_setting must use their own permission-checked commands.
const settingValueSchema = z.string().max(200_000);
const rundownPinSchema = z.string().regex(/^\d{4,8}$/u, "PIN must contain 4 to 8 digits.");
const rundownPinUpdateSchema = z.discriminatedUnion("action", [
  z.object({ orgId: idSchema, action: z.literal("set"), pin: rundownPinSchema }),
  z.object({ orgId: idSchema, action: z.literal("disable") }),
]);

async function getOrgMembership(orgId: string) {
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
  return { role, userId: session.user.id };
}

async function getOrgMemberRole(orgId: string) {
  return (await getOrgMembership(orgId)).role;
}

async function assertOrgAccess(orgId: string) {
  await getOrgMemberRole(orgId);
}

async function assertOrgPermission(orgId: string, permission: Permission) {
  const { role, userId } = await getOrgMembership(orgId);
  if (!hasPermission(role, permission)) throw new Error("Forbidden");
  return userId;
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
  if (!value || value === "native" || value === CREDENTIAL_MASK) return;
  const { requirePlanFeature } = await import("@/lib/plan-limits");
  await requirePlanFeature(orgId, "integrations");
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
      where: { orgId: data.orgId, key: { in: EDITABLE_SETTING_KEYS } },
      select: { key: true, value: true },
    });
    return Object.fromEntries(
      settings
        .filter((setting) => isEditableSettingKey(setting.key))
        .filter((setting) => hasPermission(role, permissionForSettingKey(setting.key)))
        .map((setting) => [setting.key, maskSettingValue(setting.key, setting.value)]),
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
      await refreshOrgReadAuthority(data.orgId);
      return { enabled: false as const };
    }

    const value = await hashRundownPin(data.pin);
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY } },
      update: { value },
      create: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY, value },
    });
    await refreshOrgReadAuthority(data.orgId);
    return { enabled: true as const };
  });

const PROPRESENTER_PUBLIC_SETTING_KEYS = [
  "propresenter-host", "propresenter-port", "propresenter-api-port",
  "propresenter-send-cues", "propresenter-stage-display",
] as const;

/** Operator configuration contains no credentials; the venue Bridge authenticates privately. */
export const getProPresenterConfiguration = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertEffectiveOrgPermission(data.orgId, ["lowerthird:trigger", "rundown:control"]);
    const settings = await getPrisma().appSetting.findMany({
      where: { orgId: data.orgId, key: { in: [...PROPRESENTER_PUBLIC_SETTING_KEYS] } },
      select: { key: true, value: true },
    });
    return Object.fromEntries(settings.map(setting => [setting.key, maskSettingValue(setting.key, setting.value)]));
  });

/** Retains the API-key permission check before native installation reuse/provisioning. */
export const getDesktopBridgeAccess = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:api_keys");
    return { orgId: data.orgId };
  });

async function recordCredentialSettingChange(orgId: string, key: string, value: string, wasConfigured: boolean) {
  if (key !== "webhook-url") return;
  try {
    await appendWebhookEvent(getPrisma(), orgId, {
      source: "settings", type: wasConfigured ? "webhook-url-updated" : "webhook-url-set",
      direction: "system", status: "info",
      details: value ? "Incoming webhook URL has been configured." : "Incoming webhook URL has been cleared.",
    });
  } catch { /* Telemetry must not turn a committed setting into a failed save. */ }
}

export const updateOrgSetting = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(settingWriteSchema, data))
  .handler(async ({ data }) => {
    const userId = await assertOrgPermission(data.orgId, permissionForSettingKey(data.key));
    if (data.key === CONFIDENCE_LAYOUT_KEY) confidenceLayoutSchema.parse(JSON.parse(data.value));
    await assertIntegrationPlanAllows(data.orgId, data.key, data.value);
    return applySettingWrite(getD1(), data, userId);
  });

export const updateOrgCredential = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    key: genericSettingKeySchema.refine(isCredentialField, "Choose a credential setting."),
    change: z.discriminatedUnion("action", [
      z.object({ action: z.literal("keep") }),
      z.object({ action: z.literal("replace"), value: settingValueSchema.min(1) }),
      z.object({ action: z.literal("clear") }),
    ]),
  }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, permissionForSettingKey(data.key));
    const prisma = getPrisma();
    if (data.change.action === "keep") {
      const row = await prisma.appSetting.findUnique({ where: { orgId_key: { orgId: data.orgId, key: data.key } }, select: { value: true } });
      return { key: data.key, value: row ? maskSettingValue(data.key, row.value) : "" };
    }
    const value = data.change.action === "clear" ? "" : data.change.value;
    await assertIntegrationPlanAllows(data.orgId, data.key, value);
    const storedValue = await encryptSettingValue(env.CREDENTIAL_ENCRYPTION_KEYS, data.orgId, data.key, value);
    const previousSetting = data.key === "webhook-url"
      ? await prisma.appSetting.findUnique({ where: { orgId_key: { orgId: data.orgId, key: data.key } }, select: { value: true } }) : null;
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: data.key } },
      create: { orgId: data.orgId, key: data.key, value: storedValue }, update: { value: storedValue },
    });
    await recordCredentialSettingChange(data.orgId, data.key, value, Boolean(previousSetting?.value));
    return { key: data.key, value: maskSettingValue(data.key, storedValue) };
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
  confidenceLayout: ConfidenceLayout;
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
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgSlug: z.string().min(1).max(128) }), data))
  .handler(async ({ data }): Promise<DisplaySettingsBySlug> => {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({ where: { slug: data.orgSlug } });
    if (!org) {
      return {
        confidenceLayout: DEFAULT_CONFIDENCE_LAYOUT,
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

    await requireDisplayAccess(env.DB, getRequest(), org.id, "timer", env.KIOSK_SECRET);
    const [settings, shows] = await Promise.all([
      prisma.appSetting.findMany({
        where: {
          orgId: org.id,
          key: { in: [
            CONFIDENCE_LAYOUT_KEY,
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
      confidenceLayout: readConfidenceLayout(map[CONFIDENCE_LAYOUT_KEY]),
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
