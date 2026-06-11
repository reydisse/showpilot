import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole, type Permission } from "@/lib/app-permissions";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";

// Style is a JSON blob of overlay styling — bound generously.
const styleSchema = z.string().max(20_000);
const graphicTextSchema = z.string().max(500);
const orgGraphicSchema = z.object({ orgId: idSchema, graphicId: idSchema });

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

async function assertGraphicPermission(orgId: string, permission: Permission) {
  const role = await getOrgMemberRole(orgId);
  if (!hasPermission(role, permission)) throw new Error("Forbidden");

  const prisma = getPrisma();
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { cloud_enabled: true },
  });

  if (!org?.cloud_enabled) {
    throw new Error("Forbidden");
  }
}

// ─── Graphic Templates ─────────────────────────────────────

export const getGraphicTemplates = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:view");
    const prisma = getPrisma();
    return await prisma.graphicTemplate.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
  });

export const addGraphicTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        name: labelSchema,
        title: graphicTextSchema,
        subtitle: graphicTextSchema.optional(),
        style: styleSchema.optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:configure");
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
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        id: idSchema,
        updates: z
          .object({
            name: labelSchema,
            title: graphicTextSchema,
            subtitle: graphicTextSchema,
            style: styleSchema,
          })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:configure");
    const prisma = getPrisma();
    return await prisma.graphicTemplate.updateMany({
      where: { id: data.id, orgId: data.orgId },
      data: data.updates,
    });
  });

export const deleteGraphicTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:configure");
    const prisma = getPrisma();
    await prisma.graphicTemplate.deleteMany({ where: { id: data.id, orgId: data.orgId } });
  });

// ─── Active Graphics (via AppSetting) ───────────────────────
//
// Multiple lower thirds can be live at once (e.g. two panelists), so the
// active state is a list of graphic IDs stored as JSON under "active-graphics".
// The legacy single-value "active-graphic" key is still read as a fallback so
// nothing breaks during/after the transition.

const ACTIVE_KEY = "active-graphics";
const LEGACY_KEY = "active-graphic";

type PrismaClientLike = ReturnType<typeof getPrisma>;

async function readActiveIds(prisma: PrismaClientLike, orgId: string): Promise<string[]> {
  const multi = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: ACTIVE_KEY } },
  });
  if (multi?.value) {
    try {
      const arr = JSON.parse(multi.value);
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
    } catch {
      // fall through to legacy
    }
  }
  const legacy = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: LEGACY_KEY } },
  });
  return legacy?.value ? [legacy.value] : [];
}

async function writeActiveIds(prisma: PrismaClientLike, orgId: string, ids: string[]) {
  // De-dupe while preserving order.
  const unique = [...new Set(ids)];
  // Clear the legacy single key so it can't shadow the multi value.
  await prisma.appSetting.deleteMany({ where: { orgId, key: LEGACY_KEY } });
  if (unique.length === 0) {
    await prisma.appSetting.deleteMany({ where: { orgId, key: ACTIVE_KEY } });
    return;
  }
  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key: ACTIVE_KEY } },
    create: { orgId, key: ACTIVE_KEY, value: JSON.stringify(unique) },
    update: { value: JSON.stringify(unique) },
  });
}

// Keep only IDs that still belong to this org, preserving stored order.
async function resolveActive(prisma: PrismaClientLike, orgId: string) {
  const ids = await readActiveIds(prisma, orgId);
  if (ids.length === 0) return { ids: [] as string[], templates: [] as Awaited<ReturnType<typeof prisma.graphicTemplate.findMany>> };
  const rows = await prisma.graphicTemplate.findMany({
    where: { id: { in: ids }, orgId },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t));
  return { ids: ordered.map((t) => t.id), templates: ordered };
}

/** Returns every active graphic, in display order. */
export const getActiveGraphics = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:view");
    const prisma = getPrisma();
    const { templates } = await resolveActive(prisma, data.orgId);
    return templates;
  });

/** Replace the entire active set with the given IDs. */
export const setActiveGraphics = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, graphicIds: z.array(idSchema).max(50) }), data),
  )
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    const prisma = getPrisma();
    // Validate ownership before writing.
    const rows = await prisma.graphicTemplate.findMany({
      where: { id: { in: data.graphicIds }, orgId: data.orgId },
      select: { id: true },
    });
    const valid = new Set(rows.map((r) => r.id));
    await writeActiveIds(prisma, data.orgId, data.graphicIds.filter((id) => valid.has(id)));
  });

/** Add one graphic to the active set (no-op if already live). */
export const addActiveGraphic = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(orgGraphicSchema, data))
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    const prisma = getPrisma();
    const owns = await prisma.graphicTemplate.findFirst({
      where: { id: data.graphicId, orgId: data.orgId },
      select: { id: true },
    });
    if (!owns) return;
    const ids = await readActiveIds(prisma, data.orgId);
    if (!ids.includes(data.graphicId)) {
      await writeActiveIds(prisma, data.orgId, [...ids, data.graphicId]);
    }
  });

/** Remove one graphic from the active set. */
export const removeActiveGraphic = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(orgGraphicSchema, data))
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    const prisma = getPrisma();
    const ids = await readActiveIds(prisma, data.orgId);
    await writeActiveIds(prisma, data.orgId, ids.filter((id) => id !== data.graphicId));
  });

/** Toggle one graphic on/off; returns the new active ID list. */
export const toggleActiveGraphic = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(orgGraphicSchema, data))
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    const prisma = getPrisma();
    const ids = await readActiveIds(prisma, data.orgId);
    let next: string[];
    if (ids.includes(data.graphicId)) {
      next = ids.filter((id) => id !== data.graphicId);
    } else {
      const owns = await prisma.graphicTemplate.findFirst({
        where: { id: data.graphicId, orgId: data.orgId },
        select: { id: true },
      });
      next = owns ? [...ids, data.graphicId] : ids;
    }
    await writeActiveIds(prisma, data.orgId, next);
    return next;
  });

/** Clear all active graphics. */
export const clearActiveGraphics = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    const prisma = getPrisma();
    await writeActiveIds(prisma, data.orgId, []);
  });

// ─── Backward-compatible single-graphic helpers ─────────────

/** Replace the active set with a single graphic, or clear it when null. */
export const setActiveGraphic = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, graphicId: idSchema.nullable() }), data),
  )
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    const prisma = getPrisma();
    await writeActiveIds(prisma, data.orgId, data.graphicId ? [data.graphicId] : []);
  });

/** Returns the first active graphic (legacy single-value readers). */
export const getActiveGraphic = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:view");
    const prisma = getPrisma();
    const { templates } = await resolveActive(prisma, data.orgId);
    return templates[0] ?? null;
  });

export const getActiveGraphicBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: { orgSlug: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
    });
    if (!org) return null;
    const { templates } = await resolveActive(prisma, org.id);
    return templates[0] ?? null;
  });
