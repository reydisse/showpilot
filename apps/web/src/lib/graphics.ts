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

// ─── Graphic Templates ─────────────────────────────────────

export const getGraphicTemplates = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.graphicTemplate.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
  });

export const addGraphicTemplate = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      name: string;
      title: string;
      subtitle?: string;
      style?: string;
    }) => data
  )
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.graphicTemplate.create({
      data: {
        orgId: data.orgId,
        name: data.name,
        title: data.title,
        subtitle: data.subtitle ?? "",
        style: data.style ?? "{}",
      },
    });
  });

export const updateGraphicTemplate = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        name: string;
        title: string;
        subtitle: string;
        style: string;
      }>;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.graphicTemplate.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteGraphicTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.graphicTemplate.delete({ where: { id: data.id } });
  });

// ─── Active Graphic (via AppSetting) ────────────────────────

export const setActiveGraphic = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; graphicId: string | null }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    if (data.graphicId) {
      await prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key: "active-graphic" } },
        create: { orgId: data.orgId, key: "active-graphic", value: data.graphicId },
        update: { value: data.graphicId },
      });
    } else {
      await prisma.appSetting.deleteMany({
        where: { orgId: data.orgId, key: "active-graphic" },
      });
    }
  });

export const getActiveGraphic = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "active-graphic" } },
    });
    if (!setting) return null;
    const template = await prisma.graphicTemplate.findUnique({
      where: { id: setting.value },
    });
    return template;
  });

export const getActiveGraphicBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: { orgSlug: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
    });
    if (!org) return null;
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: org.id, key: "active-graphic" } },
    });
    if (!setting) return null;
    const template = await prisma.graphicTemplate.findUnique({
      where: { id: setting.value },
    });
    return template;
  });
