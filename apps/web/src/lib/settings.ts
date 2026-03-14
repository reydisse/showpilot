import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";

// ─── Org Settings (AppSetting table) ────────────────────────

export const getOrgSettings = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
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

// ─── Danger Zone ────────────────────────────────────────────

export const deleteOrgSettings = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; keys: string[] }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.appSetting.deleteMany({
      where: { orgId: data.orgId, key: { in: data.keys } },
    });
  });
