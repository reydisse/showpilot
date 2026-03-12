import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";

// ─── Types ────────────────────────────────────────────────────

export type LowerThirdType = "person" | "scripture" | "freetext" | "style";

export type LowerThirdState = "idle" | "live" | "clearing";

export interface LowerThirdPayload {
  id: string;
  type: LowerThirdType;
  name?: string;
  title?: string;
  scripture?: string;
  translation?: string;
  line1?: string;
  line2?: string;
  style: string; // "default" | "minimal" | "scripture"
  state: LowerThirdState;
  triggeredBy?: string;
  triggeredAt?: string;
}

// ─── Get Active Lower Third State ─────────────────────────────

export const getLowerThirdState = createServerFn({ method: "GET" })
  .inputValidator((data: { orgSlug: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();

    // Look up the org by slug
    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
    });
    if (!org) return null;

    // Get the active lower third from AppSetting
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: org.id, key: "active-lower-third" } },
    });
    if (!setting) return null;

    try {
      return JSON.parse(setting.value) as LowerThirdPayload;
    } catch {
      return null;
    }
  });

// ─── Get Active Lower Third by OrgId ──────────────────────────

export const getLowerThirdStateByOrgId = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();

    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "active-lower-third" } },
    });
    if (!setting) return null;

    try {
      return JSON.parse(setting.value) as LowerThirdPayload;
    } catch {
      return null;
    }
  });

// ─── Trigger a Lower Third ───────────────────────────────────

export const triggerLowerThird = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      payload: Omit<LowerThirdPayload, "state" | "triggeredAt">;
      triggeredBy?: string;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();

    const fullPayload: LowerThirdPayload = {
      ...data.payload,
      state: "live",
      triggeredBy: data.triggeredBy ?? "unknown",
      triggeredAt: new Date().toISOString(),
    };

    await prisma.appSetting.upsert({
      where: {
        orgId_key: { orgId: data.orgId, key: "active-lower-third" },
      },
      create: {
        orgId: data.orgId,
        key: "active-lower-third",
        value: JSON.stringify(fullPayload),
      },
      update: {
        value: JSON.stringify(fullPayload),
      },
    });

    return fullPayload;
  });

// ─── Clear Active Lower Third ─────────────────────────────────

export const clearLowerThird = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();

    await prisma.appSetting.deleteMany({
      where: { orgId: data.orgId, key: "active-lower-third" },
    });
  });

// ─── Get Lower Third Library (from GraphicTemplate) ───────────

export const getLowerThirdLibrary = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.graphicTemplate.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
  });
