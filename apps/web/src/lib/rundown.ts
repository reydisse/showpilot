import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import type { RundownItem, NativeTimerState, RundownState } from "@/types/rundown";

function rundownItemsKey(serviceDate: string) {
  return `rundown-items:${serviceDate}`;
}

function rundownTimerKey(serviceDate: string) {
  return `rundown-timer:${serviceDate}`;
}

const defaultTimer: NativeTimerState = {
  playback: "stop",
  currentItemId: null,
  elapsed: 0,
  startedAt: null,
  pausedAt: null,
  mode: "count-down",
  serverTime: Date.now(),
};

/**
 * Get the rundown state for an org on a specific service date.
 */
export const getRundownState = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; serviceDate: string }) => data)
  .handler(async ({ data }): Promise<RundownState> => {
    const prisma = getPrisma();

    const [itemsSetting, timerSetting] = await Promise.all([
      prisma.appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: rundownItemsKey(data.serviceDate) } },
      }),
      prisma.appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: rundownTimerKey(data.serviceDate) } },
      }),
    ]);

    const items: RundownItem[] = itemsSetting
      ? JSON.parse(itemsSetting.value)
      : [];

    const timer: NativeTimerState = timerSetting
      ? JSON.parse(timerSetting.value)
      : { ...defaultTimer, serverTime: Date.now() };

    return { items, timer };
  });

/**
 * Persist rundown items for an org on a specific service date.
 */
export const saveRundownItems = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; serviceDate: string; items: RundownItem[] }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const key = rundownItemsKey(data.serviceDate);
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key } },
      update: { value: JSON.stringify(data.items) },
      create: {
        orgId: data.orgId,
        key,
        value: JSON.stringify(data.items),
      },
    });
    return { ok: true };
  });

/**
 * Persist timer state for an org on a specific service date.
 */
export const saveRundownTimer = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; serviceDate: string; timer: NativeTimerState }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const key = rundownTimerKey(data.serviceDate);
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key } },
      update: { value: JSON.stringify(data.timer) },
      create: {
        orgId: data.orgId,
        key,
        value: JSON.stringify(data.timer),
      },
    });
    return { ok: true };
  });

function rundownMessageKey(serviceDate: string) {
  return `rundown-message:${serviceDate}`;
}

/**
 * Persist a stage message for an org on a specific service date.
 */
export const saveRundownMessage = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; serviceDate: string; message: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const key = rundownMessageKey(data.serviceDate);
    if (!data.message) {
      await prisma.appSetting.deleteMany({ where: { orgId: data.orgId, key } });
    } else {
      await prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key } },
        update: { value: data.message },
        create: { orgId: data.orgId, key, value: data.message },
      });
    }
    return { ok: true };
  });
