import { getRequestHeaders } from "@tanstack/react-start/server";
import { inventoryCommandSchema } from "./show-inventory-contract";
import { writeShowInventory } from "./show-inventory-write.server";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";
import type { RundownItem } from "@/types/rundown";

const SAVED_TEMPLATE_PREFIX = "rundown-saved:";

type InventoryDelegate = Prisma.ShowInventoryItemDelegate;

function inventoryDelegate(): InventoryDelegate | undefined {
  // Older dev servers can retain a Prisma client generated before migration
  // 0025. The schedule must remain usable until that process is restarted.
  return (getPrisma() as unknown as { showInventoryItem?: InventoryDelegate })
    .showInventoryItem;
}

function requireInventoryDelegate(): InventoryDelegate {
  const delegate = inventoryDelegate();
  if (!delegate) {
    throw new Error(
      "Show inventory is unavailable until the Prisma client is regenerated and the app is restarted.",
    );
  }
  return delegate;
}

function isMissingInventoryTable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /show_inventory_item|no such table|does not exist/i.test(message);
}

async function assertInventoryAccess(orgId: string, manage = false) {
  const permission = manage ? "schedule:manage" : "schedule:view";
  await assertOrgPermission(orgId, permission);
}

function parseItems(value: string | undefined): RundownItem[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { items?: unknown }).items)
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

function parseSavedSources(values: string[]): SavedRundownSource[] {
  return values.flatMap((value) => {
    try {
      const row = JSON.parse(value) as {
        id?: unknown;
        name?: unknown;
        items?: unknown;
      };
      if (typeof row.id !== "string" || typeof row.name !== "string") return [];
      return [
        {
          id: row.id,
          name: row.name,
          itemCount: Array.isArray(row.items) ? row.items.length : 0,
        },
      ];
    } catch {
      return [];
    }
  });
}

function mapInventoryRows(
  rows: Awaited<ReturnType<NonNullable<InventoryDelegate>["findMany"]>>,
): ShowInventorySummary[] {
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
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), value),
  )
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
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), value),
  )
  .handler(
    async ({
      data,
    }): Promise<{
      inventory: ShowInventorySummary[];
      archivedInventory: ShowInventorySummary[];
      savedTemplates: SavedRundownSource[];
    }> => {
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
          throw new Error(
            "Show inventory migration 0025 has not been applied.",
          );
        }
        throw error;
      }
      const settings = await prisma.appSetting.findMany({
        where: {
          orgId: data.orgId,
          key: { startsWith: SAVED_TEMPLATE_PREFIX },
        },
        select: { value: true },
      });
      const mapped = mapInventoryRows(rows);
      return {
        inventory: mapped.filter((row) => !row.archivedAt),
        archivedInventory: mapped.filter((row) => Boolean(row.archivedAt)),
        savedTemplates: parseSavedSources(
          settings.map((setting) => setting.value),
        ),
      };
    },
  );

/** Existing rundown templates are valid inventory sources as well. */
export const listSavedRundownSources = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), value),
  )
  .handler(async ({ data }): Promise<SavedRundownSource[]> => {
    await assertInventoryAccess(data.orgId);
    const settings = await getPrisma().appSetting.findMany({
      where: { orgId: data.orgId, key: { startsWith: SAVED_TEMPLATE_PREFIX } },
      select: { value: true },
    });
    return parseSavedSources(settings.map((setting) => setting.value));
  });

export const mutateShowInventory = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(inventoryCommandSchema, value),
  )
  .handler(
    async ({ data }) =>
      (await writeShowInventory(data, getRequestHeaders())).result,
  );

export const reviewShowInventory = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) =>
    parseOrThrow(inventoryCommandSchema, value),
  )
  .handler(
    async ({ data }) =>
      (await writeShowInventory(data, getRequestHeaders(), "review")).result,
  );
