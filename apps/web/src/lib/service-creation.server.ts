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
  const showCount = await prisma.rundown.count({ where: { orgId: data.orgId } });
  await checkPlanLimit(data.orgId, "shows", showCount);

  const inventory = data.inventoryId
    ? await readShowInventoryItem(data.orgId, data.inventoryId)
    : null;
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
  const timezone = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId: data.orgId, key: "org-timezone" } },
    select: { value: true },
  });
  const scheduledStartIso = serviceTimeToIso(data.serviceDate, startTime, timezone?.value);
  const scheduledStartTime = scheduledStartIso ? new Date(scheduledStartIso) : null;
  const rundown = await prisma.rundown.create({
    data: {
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
