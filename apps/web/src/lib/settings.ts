import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";

async function assertOrgAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { id: true },
  });
  if (!member) throw new Error("Forbidden");
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
  .inputValidator((data: { orgId: string; key: string; value: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: data.key } },
      update: { value: data.value },
      create: { orgId: data.orgId, key: data.key, value: data.value },
    });
  });

export const bulkUpdateOrgSettings = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { orgId: string; settings: { key: string; value: string }[] }) =>
      data
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
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

// ─── Org Members ────────────────────────────────────────────

export const getOrgMembers = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.member.findMany({
      where: { organizationId: data.orgId },
      include: { user: true },
    });
  });

// ─── API Key ────────────────────────────────────────────────

export const regenerateApiKey = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
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
  .inputValidator((data: { orgId: string; keys: string[] }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    await prisma.appSetting.deleteMany({
      where: { orgId: data.orgId, key: { in: data.keys } },
    });
  });
