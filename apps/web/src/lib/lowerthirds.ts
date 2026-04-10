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
    await assertOrgAccess(data.orgId);
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
    await assertOrgAccess(data.orgId);
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
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();

    await prisma.appSetting.deleteMany({
      where: { orgId: data.orgId, key: "active-lower-third" },
    });
  });

// ─── Get Lower Third Library (from GraphicTemplate) ───────────

export const getLowerThirdLibrary = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.graphicTemplate.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
  });

export const resetLowerThirdLibrary = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    await prisma.graphicTemplate.deleteMany({ where: { orgId: data.orgId } });
  });
