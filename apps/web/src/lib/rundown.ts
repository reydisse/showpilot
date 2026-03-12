import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import type { RundownItem, NativeTimerState, RundownState } from "@/types/rundown";

const RUNDOWN_ITEMS_KEY = "rundown-items";
const RUNDOWN_TIMER_KEY = "rundown-timer";

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
 * Get the current rundown state (items + timer) for an org.
 * Reads from AppSetting with keys "rundown-items" and "rundown-timer".
 */
export const getRundownState = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<RundownState> => {
    const prisma = getPrisma();

    const [itemsSetting, timerSetting] = await Promise.all([
      prisma.appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_ITEMS_KEY } },
      }),
      prisma.appSetting.findUnique({
        where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_TIMER_KEY } },
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
 * Persist rundown items for an org.
 * Upserts into AppSetting with key "rundown-items".
 */
export const saveRundownItems = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; items: RundownItem[] }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_ITEMS_KEY } },
      update: { value: JSON.stringify(data.items) },
      create: {
        orgId: data.orgId,
        key: RUNDOWN_ITEMS_KEY,
        value: JSON.stringify(data.items),
      },
    });
    return { ok: true };
  });

/**
 * Persist timer state for an org.
 * Upserts into AppSetting with key "rundown-timer".
 */
export const saveRundownTimer = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; timer: NativeTimerState }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_TIMER_KEY } },
      update: { value: JSON.stringify(data.timer) },
      create: {
        orgId: data.orgId,
        key: RUNDOWN_TIMER_KEY,
        value: JSON.stringify(data.timer),
      },
    });
    return { ok: true };
  });
