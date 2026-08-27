import { getPrisma } from "@/lib/db";
import { checkPlanLimit } from "@/lib/plan-limits";
import {
  getRundownStateForOrg,
  normalizeLegacyRundownItems,
  persistRundownItemsForOrg,
} from "@/lib/rundown";
import { readShowInventoryItem } from "@/lib/show-inventory";
import type { RundownItem } from "@/types/rundown";
import { serviceTimeToIso } from "@/lib/utils";

export interface CreateServiceForOrgInput {
  orgId: string;
  requestId?: string;
  serviceDate: string;
  copyFrom?: string;
  copyFromShowId?: string;
  name?: string;
  startTime?: string;
  location?: string;
  inventoryId?: string;
}

/**
 * Create one show after the caller has authorized `schedule:manage`.
 * Both the web server function and native HTTP adapter use this mutation so
 * plan limits, timezone conversion, and cloned execution-state resets cannot
 * drift between clients.
 */
export async function createServiceForOrg(data: CreateServiceForOrgInput) {
  const prisma = getPrisma();
  const timezone = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId: data.orgId, key: "org-timezone" } },
    select: { value: true },
  });
  const inventory = data.inventoryId
    ? await readShowInventoryItem(data.orgId, data.inventoryId)
    : null;
  if (data.requestId) {
    const existing = await prisma.rundown.findUnique({
      where: { id: data.requestId },
      select: { id: true, orgId: true, serviceDate: true, name: true, location: true, scheduledStartTime: true },
    });
    if (existing) {
      if (existing.orgId !== data.orgId) throw new Error("Show request ID is already in use");
      const expectedStart = serviceTimeToIso(
        data.serviceDate,
        data.startTime || inventory?.defaultStartTime || "",
        timezone?.value,
      );
      if (
        existing.serviceDate !== data.serviceDate
        || existing.name !== (data.name?.trim() || inventory?.name || "")
        || existing.location !== (data.location || inventory?.location || "")
        || (existing.scheduledStartTime?.toISOString() ?? null) !== expectedStart
      ) throw new Error("Show request ID was already used with different details");
      return { ok: true as const, showId: existing.id, serviceDate: existing.serviceDate };
    }
  }
  const showCount = await prisma.rundown.count({ where: { orgId: data.orgId } });
  await checkPlanLimit(data.orgId, "shows", showCount);

  if (data.inventoryId && !inventory) {
    throw new Error("Show inventory item not found");
  }

  let sourceItems: RundownItem[] = [];
  if (inventory) {
    try {
      const parsed: unknown = JSON.parse(inventory.rundownJson);
      sourceItems = normalizeLegacyRundownItems(parsed);
    } catch {
      sourceItems = [];
    }
  } else if (data.copyFrom) {
    const source = await getRundownStateForOrg({
      orgId: data.orgId,
      serviceDate: data.copyFrom,
      showId: data.copyFromShowId,
    });
    sourceItems = source.items;
  }

  const startTime = data.startTime || inventory?.defaultStartTime || "";
  const scheduledStartIso = serviceTimeToIso(data.serviceDate, startTime, timezone?.value);
  const scheduledStartTime = scheduledStartIso ? new Date(scheduledStartIso) : null;
  const rundown = await prisma.rundown.create({
    data: {
      ...(data.requestId ? { id: data.requestId } : {}),
      orgId: data.orgId,
      serviceDate: data.serviceDate,
      scheduledStartTime,
      status: "stopped",
      name: data.name?.trim() || inventory?.name || "",
      location: data.location || inventory?.location || "",
    },
    select: { id: true },
  });

  const cloned: RundownItem[] = sourceItems.map((item, index) => ({
    ...item,
    id: `${rundown.id}-${index}`,
    status: "upcoming",
    scheduledStart: null,
    expectedEnd: null,
    actualStart: null,
    actualEnd: null,
  }));
  try {
    await persistRundownItemsForOrg(
      data.orgId,
      data.serviceDate,
      cloned,
      rundown.id,
    );
  } catch (error) {
    await prisma.$transaction([
      prisma.rundown.deleteMany({ where: { id: rundown.id, orgId: data.orgId } }),
      prisma.appSetting.deleteMany({
        where: { orgId: data.orgId, key: `rundown-items:${rundown.id}` },
      }),
    ]);
    throw error;
  }

  return { ok: true as const, showId: rundown.id, serviceDate: data.serviceDate };
}
