import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { hasPermission } from "@/lib/app-permissions";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";
import type { RundownItem } from "@/types/rundown";

const startTimeSchema = z.union([
  z.literal(""),
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
]);

const inventoryInput = z.object({
  orgId: idSchema,
  name: labelSchema,
  description: z.string().trim().max(500).default(""),
  location: z.string().trim().max(240).default(""),
  defaultStartTime: startTimeSchema.default(""),
  sourceTemplateId: z.union([idSchema, z.literal("")]).optional(),
});

const SAVED_TEMPLATE_PREFIX = "rundown-saved:";

type InventoryDelegate = Prisma.ShowInventoryItemDelegate;

function inventoryDelegate(): InventoryDelegate | undefined {
  // Older dev servers can retain a Prisma client generated before migration
  // 0025. The schedule must remain usable until that process is restarted.
  return (getPrisma() as unknown as { showInventoryItem?: InventoryDelegate }).showInventoryItem;
}

function requireInventoryDelegate(): InventoryDelegate {
  const delegate = inventoryDelegate();
  if (!delegate) {
    throw new Error("Show inventory is unavailable until the Prisma client is regenerated and the app is restarted.");
  }
  return delegate;
}

function isMissingInventoryTable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /show_inventory_item|no such table|does not exist/i.test(message);
}

async function assertInventoryAccess(orgId: string, manage = false) {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const permission = manage ? "schedule:manage" : "schedule:view";
  if (!member || !hasPermission(member.role ?? "member", permission)) {
    throw new Error("Forbidden");
  }
}

function parseItems(value: string | undefined): RundownItem[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : [];
    return items.filter((item): item is RundownItem => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.title === "string";
    });
  } catch {
    return [];
  }
}

export type ShowInventorySummary = {
  id: string;
  name: string;
  description: string;
  location: string;
  defaultStartTime: string | null;
  sourceTemplateId: string | null;
  itemCount: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SavedRundownSource = {
  id: string;
  name: string;
  itemCount: number;
};

function parseSavedSources(value: string | undefined): SavedRundownSource[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as Array<{ id?: unknown; name?: unknown; itemCount?: unknown }>;
    return parsed
      .filter((row) => typeof row.id === "string" && typeof row.name === "string")
      .map((row) => ({
        id: row.id as string,
        name: row.name as string,
        itemCount: typeof row.itemCount === "number" ? row.itemCount : 0,
      }));
  } catch {
    return [];
  }
}

function mapInventoryRows(rows: Awaited<ReturnType<NonNullable<InventoryDelegate>["findMany"]>>): ShowInventorySummary[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    location: row.location,
    defaultStartTime: row.defaultStartTime,
    sourceTemplateId: row.sourceTemplateId,
    itemCount: parseItems(row.rundownJson).length,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function readShowInventoryItem(orgId: string, id: string) {
  const delegate = requireInventoryDelegate();
  try {
    return await delegate.findFirst({ where: { id, orgId, archivedAt: null } });
  } catch (error) {
    if (isMissingInventoryTable(error)) {
      throw new Error("Show inventory migration 0025 has not been applied.");
    }
    throw error;
  }
}

export const listShowInventory = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema }), value))
  .handler(async ({ data }): Promise<ShowInventorySummary[]> => {
    await assertInventoryAccess(data.orgId);
    const delegate = requireInventoryDelegate();
    let rows;
    try {
      rows = await delegate.findMany({
        where: { orgId: data.orgId, archivedAt: null },
        orderBy: [{ name: "asc" }, { createdAt: "desc" }],
      });
    } catch (error) {
      if (isMissingInventoryTable(error)) {
        throw new Error("Show inventory migration 0025 has not been applied.");
      }
      throw error;
    }
    return mapInventoryRows(rows);
  });

/** Single schedule-loader read for the catalog and legacy template sources. */
export const getShowInventoryData = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema }), value))
  .handler(async ({ data }): Promise<{ inventory: ShowInventorySummary[]; archivedInventory: ShowInventorySummary[]; savedTemplates: SavedRundownSource[] }> => {
    await assertInventoryAccess(data.orgId);
    const prisma = getPrisma();
    const delegate = requireInventoryDelegate();
    let rows: Awaited<ReturnType<NonNullable<InventoryDelegate>["findMany"]>>;
    try {
      rows = await delegate.findMany({
        where: { orgId: data.orgId },
        orderBy: [{ name: "asc" }, { createdAt: "desc" }],
      });
    } catch (error) {
      if (isMissingInventoryTable(error)) {
        throw new Error("Show inventory migration 0025 has not been applied.");
      }
      throw error;
    }
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "rundown-saved-index" } },
      select: { value: true },
    });
    const mapped = mapInventoryRows(rows);
    return {
      inventory: mapped.filter((row) => !row.archivedAt),
      archivedInventory: mapped.filter((row) => Boolean(row.archivedAt)),
      savedTemplates: parseSavedSources(setting?.value),
    };
  });

/** Existing rundown templates are valid inventory sources as well. */
export const listSavedRundownSources = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema }), value))
  .handler(async ({ data }): Promise<SavedRundownSource[]> => {
    await assertInventoryAccess(data.orgId);
    const setting = await getPrisma().appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "rundown-saved-index" } },
      select: { value: true },
    });
    if (!setting) return [];
    return parseSavedSources(setting.value);
  });

export const createShowInventoryItem = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(inventoryInput, value))
  .handler(async ({ data }) => {
    await assertInventoryAccess(data.orgId, true);
    const delegate = requireInventoryDelegate();
    let rundownJson = "[]";
    const sourceTemplateId = data.sourceTemplateId || null;
    if (sourceTemplateId) {
      const template = await getPrisma().appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: `${SAVED_TEMPLATE_PREFIX}${sourceTemplateId}` } },
        select: { value: true },
      });
      if (!template) throw new Error("Saved rundown template not found");
      const items = parseItems(template.value);
      rundownJson = JSON.stringify(items.map((item, index) => ({
        ...item,
        id: `${crypto.randomUUID()}-${index}`,
        status: "upcoming",
        scheduledStart: null,
        expectedEnd: null,
        actualStart: null,
        actualEnd: null,
      })));
    }
    const row = await delegate.create({
      data: {
        orgId: data.orgId,
        name: data.name,
        description: data.description,
        location: data.location,
        defaultStartTime: data.defaultStartTime || null,
        sourceTemplateId,
        rundownJson,
      },
    });
    return { ok: true as const, id: row.id };
  });

export const archiveShowInventoryItem = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), value))
  .handler(async ({ data }) => {
    await assertInventoryAccess(data.orgId, true);
    const delegate = requireInventoryDelegate();
    const row = await delegate.findFirst({ where: { id: data.id, orgId: data.orgId, archivedAt: null }, select: { id: true } });
    if (!row) throw new Error("Show inventory item not found");
    await delegate.update({ where: { id: row.id }, data: { archivedAt: new Date() } });
    return { ok: true as const };
  });

export const restoreShowInventoryItem = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, id: idSchema }), value))
  .handler(async ({ data }) => {
    await assertInventoryAccess(data.orgId, true);
    const delegate = requireInventoryDelegate();
    const row = await delegate.findFirst({
      where: { id: data.id, orgId: data.orgId, archivedAt: { not: null } },
      select: { id: true },
    });
    if (!row) throw new Error("Archived show inventory item not found");
    await delegate.update({ where: { id: row.id }, data: { archivedAt: null } });
    return { ok: true as const };
  });
