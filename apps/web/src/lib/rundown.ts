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

// ─── ProPresenter Slide Data ─────────────────────────────────

function ppSlideKey(serviceDate: string) {
  return `rundown-ppslide:${serviceDate}`;
}

export interface PPSlidePayload {
  text: string;
  notes: string;
  presentationName: string;
  isScripture: boolean;
  updatedAt: number;
}

/**
 * Save current ProPresenter slide data for kiosk consumption.
 * Called by operator's browser when PP slide changes.
 */
export const saveProPresenterSlide = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; serviceDate: string; slide: PPSlidePayload | null }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const key = ppSlideKey(data.serviceDate);
    if (!data.slide) {
      await prisma.appSetting.deleteMany({ where: { orgId: data.orgId, key } });
    } else {
      await prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key } },
        update: { value: JSON.stringify(data.slide) },
        create: { orgId: data.orgId, key, value: JSON.stringify(data.slide) },
      });
    }
    return { ok: true };
  });

// ─── Saved Rundown Templates ──────────────────────────────────

interface SavedRundown {
  id: string;
  name: string;
  items: RundownItem[];
  createdAt: string;
  updatedAt: string;
}

export interface SavedRundownMeta {
  id: string;
  name: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

function savedRundownKey(id: string) {
  return `rundown-saved:${id}`;
}

const SAVED_INDEX_KEY = "rundown-saved-index";

/**
 * List all saved rundown templates for an org.
 */
export const listSavedRundowns = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<SavedRundownMeta[]> => {
    const prisma = getPrisma();
    const indexSetting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: SAVED_INDEX_KEY } },
    });
    if (!indexSetting) return [];
    return JSON.parse(indexSetting.value);
  });

/**
 * Save current rundown items as a named template.
 */
export const saveRundownTemplate = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; name: string; items: RundownItem[] }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const cleanItems = data.items.map((item) => ({
      ...item,
      status: "upcoming" as const,
    }));

    const saved: SavedRundown = {
      id,
      name: data.name,
      items: cleanItems,
      createdAt: now,
      updatedAt: now,
    };

    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: savedRundownKey(id) } },
      update: { value: JSON.stringify(saved) },
      create: { orgId: data.orgId, key: savedRundownKey(id), value: JSON.stringify(saved) },
    });

    const indexSetting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: SAVED_INDEX_KEY } },
    });
    const index: SavedRundownMeta[] = indexSetting ? JSON.parse(indexSetting.value) : [];
    index.unshift({ id, name: data.name, itemCount: cleanItems.length, createdAt: now, updatedAt: now });

    await prisma.appSetting.upsert({
      where: { orgId_key: { orgId: data.orgId, key: SAVED_INDEX_KEY } },
      update: { value: JSON.stringify(index) },
      create: { orgId: data.orgId, key: SAVED_INDEX_KEY, value: JSON.stringify(index) },
    });

    return { ok: true, id };
  });

/**
 * Load a saved rundown template by ID.
 */
export const loadSavedRundown = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; rundownId: string }) => data)
  .handler(async ({ data }): Promise<RundownItem[] | null> => {
    const prisma = getPrisma();
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: savedRundownKey(data.rundownId) } },
    });
    if (!setting) return null;
    const saved: SavedRundown = JSON.parse(setting.value);
    return saved.items;
  });

/**
 * Delete a saved rundown template.
 */
export const deleteSavedRundown = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; rundownId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();

    await prisma.appSetting.deleteMany({
      where: { orgId: data.orgId, key: savedRundownKey(data.rundownId) },
    });

    const indexSetting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: SAVED_INDEX_KEY } },
    });
    if (indexSetting) {
      const index: SavedRundownMeta[] = JSON.parse(indexSetting.value);
      const filtered = index.filter((r) => r.id !== data.rundownId);
      await prisma.appSetting.update({
        where: { orgId_key: { orgId: data.orgId, key: SAVED_INDEX_KEY } },
        data: { value: JSON.stringify(filtered) },
      });
    }

    return { ok: true };
  });

/**
 * List dates that have rundown data for an org.
 */
export const listRundownDates = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<{ date: string; itemCount: number }[]> => {
    const prisma = getPrisma();
    const settings = await prisma.appSetting.findMany({
      where: { orgId: data.orgId, key: { startsWith: "rundown-items:" } },
      select: { key: true, value: true },
      orderBy: { key: "desc" },
    });

    return settings.map((s) => {
      const date = s.key.replace("rundown-items:", "");
      const items: RundownItem[] = JSON.parse(s.value);
      return { date, itemCount: items.length };
    }).filter((d) => d.itemCount > 0);
  });
