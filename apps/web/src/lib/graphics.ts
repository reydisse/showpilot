import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { withPrimaryDatabase } from "@/lib/request-database.server";
import type { Permission } from "@/lib/app-permissions";
import { assertOrgPermission } from "@/lib/org-access";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";
import { getD1 } from "@/lib/d1";
import { setGraphicPresenceForOrg } from "@/lib/active-graphics";
import { publishGraphicCompositionForOrg } from "@/lib/graphic-composition";

import { graphicSceneItemsSchema, readGraphicSceneRecord, type GraphicSceneEntry } from "./graphic-scenes";
export type { SavedGraphicScene } from "./graphic-scenes";

export { setGraphicPresenceForOrg } from "@/lib/active-graphics";
export type { GraphicCompositionItem } from "@/lib/graphic-composition";

// Style is a JSON blob of overlay styling — bound generously.
const styleSchema = z.string().max(20_000);
const graphicTextSchema = z.string().max(500);
const orgGraphicSchema = z.object({ orgId: idSchema, graphicId: idSchema });
const compositionItemSchema = z.object({
  key: idSchema,
  name: labelSchema,
  title: graphicTextSchema,
  subtitle: graphicTextSchema,
  style: styleSchema,
});
async function assertGraphicPermission(orgId: string, permission: Permission) {
  await assertOrgPermission(orgId, permission);

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
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => withPrimaryDatabase(async () => {
    await assertGraphicPermission(data.orgId, "lowerthird:view");
    const prisma = getPrisma();
    return await prisma.graphicTemplate.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
  }));

const graphicContentSchema = z.object({
  name: labelSchema,
  title: graphicTextSchema,
  subtitle: graphicTextSchema,
  style: styleSchema,
});
const libraryOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), content: graphicContentSchema }),
  z.object({ kind: z.literal("update"), id: idSchema, content: graphicContentSchema }),
  z.object({ kind: z.literal("delete"), id: idSchema }),
  z.object({ kind: z.literal("create-scene"), id: z.string().uuid(), name: labelSchema, items: graphicSceneItemsSchema }),
  z.object({ kind: z.literal("update-scene"), id: idSchema, name: labelSchema, items: graphicSceneItemsSchema }),
  z.object({ kind: z.literal("delete-scene"), id: idSchema }),
]);
export type GraphicLibraryOperation = z.infer<typeof libraryOperationSchema>;

export const mutateGraphicLibrary = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema, requestId: z.string().uuid(), operation: libraryOperationSchema,
  }), data))
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:configure");
    const { applyGraphicLibraryOperation } = await import("./graphic-library.server");
    return applyGraphicLibraryOperation(getD1(), data);
  });

const SCENE_KEY_PREFIX = "graphic-scene:";

export const getGraphicScenes = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<GraphicSceneEntry[]> => withPrimaryDatabase(async () => {
    await assertGraphicPermission(data.orgId, "lowerthird:view");
    const rows = await getPrisma().appSetting.findMany({
      where: { orgId: data.orgId, key: { startsWith: SCENE_KEY_PREFIX } },
      orderBy: { key: "asc" },
    });
    return rows.map(readGraphicSceneRecord).sort((left, right) => {
      if (left.status === "unreadable") return right.status === "unreadable" ? 0 : -1;
      if (right.status === "unreadable") return 1;
      return right.scene.updatedAt.localeCompare(left.scene.updatedAt);
    });
  }));

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

/** Atomically creates an immutable output revision and points Program at it. */
export const publishGraphicComposition = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    requestId: idSchema,
    items: z.array(compositionItemSchema).min(1).max(50),
  }), data))
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    return publishGraphicCompositionForOrg(getD1(), data);
  });

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
  .handler(async ({ data }) => withPrimaryDatabase(async () => {
    // Live output and recovery after an uncertain write must not use a stale replica.
    await assertGraphicPermission(data.orgId, "lowerthird:view");
    const prisma = getPrisma();
    const { templates } = await resolveActive(prisma, data.orgId);
    return templates;
  }));

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
    if (!owns) throw new Error("Graphic not found");
    return setGraphicPresenceForOrg(getD1(), data.orgId, data.graphicId, true);
  });

/** Remove one graphic from the active set. */
export const removeActiveGraphic = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(orgGraphicSchema, data))
  .handler(async ({ data }) => {
    await assertGraphicPermission(data.orgId, "lowerthird:trigger");
    return setGraphicPresenceForOrg(getD1(), data.orgId, data.graphicId, false);
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
    // Another operator can publish immediately after Clear. Return observed state.
    return (await resolveActive(prisma, data.orgId)).ids;
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
