import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getPrisma } from "@/lib/db";
import { hasPermission } from "@/lib/app-permissions";
import type { RundownItem, NativeTimerState, RundownState, RundownMeta, ItemType, ItemStatus } from "@/types/rundown";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow, serviceDateSchema, textSchema } from "@/lib/validation";

// ─── Input schemas ───────────────────────────────────────────
// Item arrays are validated as bounded unknowns here; per-item shape is
// owned by normalizeLegacyRundownItems, which sanitizes legacy payloads.

const orgServiceDateSchema = z.object({ orgId: idSchema, serviceDate: serviceDateSchema });

const rawItemsSchema = z.array(z.unknown()).max(500);

const timerStateSchema = z.object({
  playback: z.enum(["stop", "play", "pause"]),
  currentItemId: idSchema.nullable(),
  elapsed: z.number(),
  startedAt: z.number().nullable(),
  pausedAt: z.number().nullable(),
  mode: z.enum(["count-up", "count-down", "clock"]),
  serverTime: z.number(),
});

const hostPortSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
});

const ppSlideSchema = z.object({
  text: textSchema,
  notes: textSchema,
  presentationName: z.string().max(500),
  isScripture: z.boolean(),
  updatedAt: z.number(),
});

interface RundownRelayEnv {
  RUNDOWN_RELAY?: DurableObjectNamespace;
}

const VALID_ITEM_TYPES = new Set<ItemType>([
  "segment",
  "song",
  "prayer",
  "announcement",
  "offering",
  "custom",
]);

const VALID_ITEM_STATUSES = new Set<ItemStatus>(["upcoming", "live", "complete"]);

type RawRundownItemRow = {
  itemId: string;
  title: string;
  type: string;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: string;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId: string | null;
  scheduledStart: Date | null;
  expectedEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
};

type RelationalRundownStore = {
  findMany(args: { where: { orgId: string; serviceDate: string }; orderBy: { sortOrder: "asc" | "desc" } }):
    Promise<RawRundownItemRow[]>;
  findFirst(args: { where: { orgId: string; serviceDate: string } }): Promise<RawRundownItemRow | null>;
  upsert(args: {
    where: { orgId_serviceDate_itemId: { orgId: string; serviceDate: string; itemId: string } };
    update: Record<string, unknown>;
    create: Record<string, unknown>;
  }): Promise<unknown>;
  deleteMany(args: { where: { orgId: string; serviceDate: string; itemId?: { notIn: string[] } } }): Promise<unknown>;
};

function getRelationalRundownStore(prisma: ReturnType<typeof getPrisma>): RelationalRundownStore | null {
  const store = (prisma as unknown as { rundownItem?: RelationalRundownStore }).rundownItem;
  if (
    !store ||
    typeof store.findMany !== "function" ||
    typeof store.findFirst !== "function" ||
    typeof store.upsert !== "function" ||
    typeof store.deleteMany !== "function"
  ) {
    return null;
  }

  return store;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function toTimerMode(value: unknown): NativeTimerState["mode"] {
  if (value === "count-up" || value === "count-down" || value === "clock") {
    return value;
  }
  return "count-down";
}

function normalizeItemType(value: unknown): ItemType {
  return typeof value === "string" && VALID_ITEM_TYPES.has(value as ItemType)
    ? (value as ItemType)
    : "segment";
}

function normalizeItemStatus(value: unknown): ItemStatus {
  return typeof value === "string" && VALID_ITEM_STATUSES.has(value as ItemStatus)
    ? (value as ItemStatus)
    : "upcoming";
}

function normalizeLegacyRundownItems(value: unknown): RundownItem[] {
  if (!Array.isArray(value)) return [];

  const items: RundownItem[] = [];

  value.forEach((item, index) => {
    if (!isObject(item)) return;

    const id = toString(item.id, `item-${index}`);
    const rawStatus = toString(item.status, "upcoming");

    items.push({
      id,
      title: toString(item.title),
      type: normalizeItemType(item.type),
      duration: toNumber(item.duration, 300000),
      notes: toString(item.notes),
      assignee: toString(item.assignee),
      cue: toString(item.cue),
      status: rawStatus && VALID_ITEM_STATUSES.has(rawStatus as ItemStatus)
        ? (rawStatus as ItemStatus)
        : "upcoming",
      sortOrder: Number.isFinite(Number(item.sortOrder)) ? Number(item.sortOrder) : index,
      hardStop: toBoolean(item.hardStop),
      lowerThirdId: toString(item.lowerThirdId, "") || undefined,
    });
  });

  return items;
}

function parseRundownJson<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function normalizeTimerState(value: string | undefined | null): NativeTimerState {
  const parsed = parseRundownJson<unknown>(value, {
    playback: "stop",
    currentItemId: null,
    elapsed: 0,
    startedAt: null,
    pausedAt: null,
    mode: "count-down" as NativeTimerState["mode"],
    serverTime: Date.now(),
  });

  if (!isObject(parsed)) {
    return {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
      serverTime: Date.now(),
    };
  }

  return {
    playback:
      parsed.playback === "play" || parsed.playback === "pause" || parsed.playback === "stop"
        ? parsed.playback
        : "stop",
    currentItemId:
      typeof parsed.currentItemId === "string" && parsed.currentItemId.trim() ? parsed.currentItemId : null,
    elapsed: toNumber(parsed.elapsed, 0),
    startedAt: typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
      ? parsed.startedAt
      : null,
    pausedAt: typeof parsed.pausedAt === "number" && Number.isFinite(parsed.pausedAt)
      ? parsed.pausedAt
      : null,
    mode: toTimerMode(parsed.mode),
    serverTime: toNumber(parsed.serverTime, Date.now()),
  };
}

function mapRundownRowsToItems(rows: Array<{
  itemId: string;
  title: string;
  type: string;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: string;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId: string | null;
  scheduledStart?: Date | null;
  expectedEnd?: Date | null;
  actualStart?: Date | null;
  actualEnd?: Date | null;
}>): RundownItem[] {
  return rows.map((row) => ({
    id: row.itemId,
    title: row.title,
    type: normalizeItemType(row.type),
    duration: Math.max(0, row.duration),
    notes: row.notes,
    assignee: row.assignee,
    cue: row.cue,
    status: normalizeItemStatus(row.status),
    sortOrder: row.sortOrder,
    hardStop: row.hardStop,
    lowerThirdId: row.lowerThirdId || undefined,
    scheduledStart: row.scheduledStart ? row.scheduledStart.toISOString() : null,
    expectedEnd: row.expectedEnd ? row.expectedEnd.toISOString() : null,
    actualStart: row.actualStart ? row.actualStart.toISOString() : null,
    actualEnd: row.actualEnd ? row.actualEnd.toISOString() : null,
  }));
}

async function migrateLegacyRundownItems(
  prisma: ReturnType<typeof getPrisma>,
  orgId: string,
  serviceDate: string,
  legacyItems: RundownItem[],
) {
  const store = getRelationalRundownStore(prisma);
  if (!store) return;

  const hasRows = await store.findFirst({
    where: { orgId, serviceDate },
  });

  if (hasRows) return;

  if (legacyItems.length === 0) return;

  const itemIds = legacyItems.map((item) => item.id);

  await store.deleteMany({
    where: {
      orgId,
      serviceDate,
      ...(itemIds.length > 0
        ? { itemId: { notIn: itemIds } }
        : {}),
    },
  });

  await Promise.all(
    legacyItems.map((item, index) =>
      store.upsert({
        where: {
          orgId_serviceDate_itemId: {
            orgId,
            serviceDate,
            itemId: item.id,
          },
        },
        update: {
          title: item.title,
          type: item.type,
          duration: item.duration,
          notes: item.notes,
          assignee: item.assignee,
          cue: item.cue,
          status: item.status,
          sortOrder: index,
          hardStop: item.hardStop,
          lowerThirdId: item.lowerThirdId ?? null,
        },
        create: {
          orgId,
          serviceDate,
          itemId: item.id,
          title: item.title,
          type: item.type,
          duration: item.duration,
          notes: item.notes,
          assignee: item.assignee,
          cue: item.cue,
          status: item.status,
          sortOrder: index,
          hardStop: item.hardStop,
          lowerThirdId: item.lowerThirdId,
        },
      }),
    ),
  );
}

async function getRundownStateFromStorage(orgId: string, serviceDate: string): Promise<RundownState> {
  const prisma = getPrisma();
  const store = getRelationalRundownStore(prisma);

  let rows: RawRundownItemRow[] = [];

  if (store) {
    try {
      rows = await store.findMany({
        where: { orgId, serviceDate },
        orderBy: { sortOrder: "asc" },
      });
    } catch {
      rows = [];
    }
  }

  const [itemsSetting, timerSetting, rundownRecord] = await Promise.all([
    prisma.appSetting.findUnique({
      where: { orgId_key: { orgId, key: rundownItemsKey(serviceDate) } },
    }),
    prisma.appSetting.findUnique({
      where: { orgId_key: { orgId, key: rundownTimerKey(serviceDate) } },
    }),
    (prisma as unknown as { rundown?: { findUnique(args: { where: { orgId_serviceDate: { orgId: string; serviceDate: string } } }): Promise<{ scheduledStartTime: Date | null; status: string } | null> } }).rundown?.findUnique({
      where: { orgId_serviceDate: { orgId, serviceDate } },
    }).catch(() => null) ?? Promise.resolve(null),
  ]);

  const meta: RundownMeta = {
    serviceDate,
    scheduledStartTime: rundownRecord?.scheduledStartTime?.toISOString() ?? null,
    status: (rundownRecord?.status === "live" || rundownRecord?.status === "complete")
      ? rundownRecord.status
      : "stopped",
  };

  if (rows.length > 0) {
    return {
      items: mapRundownRowsToItems(rows),
      timer: normalizeTimerState(timerSetting?.value ?? null),
      meta,
    };
  }

  const legacyItems = normalizeLegacyRundownItems(parseRundownJson(itemsSetting?.value, []));

  if (itemsSetting?.value) {
    try {
      await migrateLegacyRundownItems(prisma, orgId, serviceDate, legacyItems);
    } catch {
      // Best effort migration. Keep source-of-truth fallback on legacy JSON if this fails.
    }
  }

  return {
    items: legacyItems,
    timer: normalizeTimerState(timerSetting?.value ?? null),
    meta,
  };
}

async function getOrgMemberRole(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { id: true, role: true },
  });
  if (!member) throw new Error("Forbidden");

  return member.role ?? "member";
}

async function assertOrgAccess(orgId: string) {
  await getOrgMemberRole(orgId);
}

async function assertRundownEditAccess(orgId: string) {
  const role = await getOrgMemberRole(orgId);
  if (!hasPermission(role, "rundown:edit")) {
    throw new Error("Forbidden");
  }
}

function rundownItemsKey(serviceDate: string) {
  return `rundown-items:${serviceDate}`;
}

function rundownTimerKey(serviceDate: string) {
  return `rundown-timer:${serviceDate}`;
}


/**
 * Get the rundown state for an org on a specific service date.
 */
export const getRundownState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(orgServiceDateSchema, data))
  .handler(async ({ data }): Promise<RundownState> => {
    await assertOrgAccess(data.orgId);
    return getRundownStateFromStorage(data.orgId, data.serviceDate);
  });

export async function getRundownStateForOrg(data: { orgId: string; serviceDate: string }): Promise<RundownState> {
  return getRundownStateFromStorage(data.orgId, data.serviceDate);
}

/**
 * Persist rundown items for an org/service date — appSetting JSON plus the
 * relational rundownItem rows. Shared by the rundown editor and the
 * onboarding template seed. Caller is responsible for access control.
 */
export async function persistRundownItemsForOrg(
  orgId: string,
  serviceDate: string,
  rawItems: unknown[],
): Promise<void> {
  const prisma = getPrisma();
  const store = getRelationalRundownStore(prisma);
  const key = rundownItemsKey(serviceDate);
  const normalizedItems = normalizeLegacyRundownItems(rawItems);

  // Plan gating: a new service date counts as a new show. Existing
  // dates can always be edited regardless of plan.
  const existing = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key } },
    select: { id: true },
  });
  if (!existing) {
    const { checkPlanLimit } = await import("@/lib/plan-limits");
    const showCount = await prisma.appSetting.count({
      where: { orgId, key: { startsWith: "rundown-items:" } },
    });
    await checkPlanLimit(orgId, "shows", showCount);
  }

  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key } },
    update: { value: JSON.stringify(normalizedItems) },
    create: {
      orgId,
      key,
      value: JSON.stringify(normalizedItems),
    },
  });

  if (!store) {
    return;
  }

  const itemIds = normalizedItems.map((item) => item.id);
  const relationalWrites: Promise<unknown>[] = [
    ...normalizedItems.map((item, index) =>
      store.upsert({
        where: {
          orgId_serviceDate_itemId: {
            orgId,
            serviceDate,
            itemId: item.id,
          },
        },
        update: {
          title: item.title,
          type: item.type,
          duration: item.duration,
          notes: item.notes,
          assignee: item.assignee,
          cue: item.cue,
          status: item.status,
          sortOrder: index,
          hardStop: item.hardStop,
          lowerThirdId: item.lowerThirdId ?? null,
        },
        create: {
          orgId,
          serviceDate,
          itemId: item.id,
          title: item.title,
          type: item.type,
          duration: item.duration,
          notes: item.notes,
          assignee: item.assignee,
          cue: item.cue,
          status: item.status,
          sortOrder: index,
          hardStop: item.hardStop,
          lowerThirdId: item.lowerThirdId,
        },
      }),
    ),
    store.deleteMany({
      where: {
        orgId,
        serviceDate,
        ...(itemIds.length > 0 ? { itemId: { notIn: itemIds } } : {}),
      },
    }),
  ];

  try {
    await Promise.all(relationalWrites);
  } catch (error) {
    console.warn("[SP] Relational rundown item write failed. Falling back to app_setting storage.", error);
  }
}

/**
 * Persist rundown items for an org on a specific service date.
 */
export const saveRundownItems = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(orgServiceDateSchema.extend({ items: rawItemsSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
    await persistRundownItemsForOrg(data.orgId, data.serviceDate, data.items);
    return { ok: true };
  });

/**
 * Persist timer state for an org on a specific service date.
 */
export const saveRundownTimer = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(orgServiceDateSchema.extend({ timer: timerStateSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
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

type RundownPrismaExt = {
  rundown?: {
    upsert(args: {
      where: { orgId_serviceDate: { orgId: string; serviceDate: string } };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
    findUnique(args: { where: { orgId_serviceDate: { orgId: string; serviceDate: string } } }): Promise<{ scheduledStartTime: Date | null; status: string } | null>;
  };
  rundownItem?: RelationalRundownStore & {
    update(args: {
      where: { orgId_serviceDate_itemId: { orgId: string; serviceDate: string; itemId: string } };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
};

/**
 * Upsert the Rundown meta record (scheduledStartTime, status).
 */
export const saveRundownMeta = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      orgServiceDateSchema.extend({
        scheduledStartTime: z.string().max(40).nullish(),
        status: z.string().max(20).optional(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
    const prisma = getPrisma() as unknown as RundownPrismaExt & ReturnType<typeof getPrisma>;
    const ext = (prisma as unknown as RundownPrismaExt).rundown;
    if (!ext) return { ok: true };

    await ext.upsert({
      where: { orgId_serviceDate: { orgId: data.orgId, serviceDate: data.serviceDate } },
      update: {
        ...(data.scheduledStartTime !== undefined
          ? { scheduledStartTime: data.scheduledStartTime ? new Date(data.scheduledStartTime) : null }
          : {}),
        ...(data.status ? { status: data.status } : {}),
      },
      create: {
        orgId: data.orgId,
        serviceDate: data.serviceDate,
        scheduledStartTime: data.scheduledStartTime ? new Date(data.scheduledStartTime) : null,
        status: data.status ?? "stopped",
      },
    });

    return { ok: true };
  });

/**
 * Patch actualStart / actualEnd on a single rundown item.
 */
export const patchRundownItemTiming = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      orgServiceDateSchema.extend({
        itemId: idSchema,
        actualStart: z.string().max(40).nullish(),
        actualEnd: z.string().max(40).nullish(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
    const prisma = getPrisma();
    const ext = (prisma as unknown as RundownPrismaExt).rundownItem as RundownPrismaExt["rundownItem"];
    if (!ext?.update) return { ok: true };

    const patch: Record<string, unknown> = {};
    if (data.actualStart !== undefined) patch.actualStart = data.actualStart ? new Date(data.actualStart) : null;
    if (data.actualEnd !== undefined) patch.actualEnd = data.actualEnd ? new Date(data.actualEnd) : null;

    await ext.update({
      where: { orgId_serviceDate_itemId: { orgId: data.orgId, serviceDate: data.serviceDate, itemId: data.itemId } },
      data: patch,
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
  .inputValidator((data: unknown) =>
    parseOrThrow(orgServiceDateSchema.extend({ message: z.string().max(2000) }), data),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
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

function ppStageDisplayKey() {
  return "propresenter-stage-display";
}

/**
 * Server-side proxy to fetch current slide from PP7 REST API.
 * Runs on the server to bypass browser CORS restrictions.
 * Tries multiple PP7 API endpoints since versions differ.
 */
export const pollProPresenterSlide = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(hostPortSchema, data))
  .handler(async ({ data }): Promise<PPSlidePayload | null> => {
    const { host, port } = data;
    const base = `http://${host}:${port}`;
    const timeout = 2000;

    // Try multiple PP7 REST endpoints in order of likelihood
    // Note: /v1/stage/layout_map returns stage display fields including timers,
    // so we try slide-specific endpoints first.
    const endpoints = [
      "/v1/stage/current_slide",
      "/v1/presentation/active",
      "/v1/status/slide",
      "/v1/presentation/slide_index",
      "/v1/stage/layout_map",
    ];

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${base}${endpoint}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) continue;
        const data = await res.json() as Record<string, unknown>;

        // Try to extract useful text from the response
        const text = extractTextFromPPResponse(data);
        if (text) {
          return {
            text,
            notes: (data.notes as string) || "",
            presentationName: (data.presentation_name as string) || (data.presentation as string) || "",
            isScripture: false,
            updatedAt: Date.now(),
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  });

/** Extract text content from various PP7 REST API response formats */
function extractTextFromPPResponse(data: Record<string, unknown>): string {
  // Direct text fields
  if (typeof data.text === "string" && data.text) return data.text;
  if (typeof data.slide_text === "string" && data.slide_text) return data.slide_text;

  // Nested slide object
  if (data.slide && typeof data.slide === "object") {
    const slide = data.slide as Record<string, unknown>;
    if (typeof slide.text === "string") return slide.text;
  }

  // Current slide in presentation context
  if (data.current && typeof data.current === "object") {
    const current = data.current as Record<string, unknown>;
    if (typeof current.text === "string") return current.text;
  }

  // Array of slides — find current
  if (Array.isArray(data.slides)) {
    const idx = typeof data.current_index === "number" ? data.current_index : 0;
    const slide = (data.slides as Array<Record<string, unknown>>)[idx];
    if (slide && typeof slide.text === "string") return slide.text;
  }

  // Layout map response (stage display) — filter out timer/clock fields
  if (Array.isArray(data.ary)) {
    const texts: string[] = [];
    for (const item of data.ary as Array<Record<string, unknown>>) {
      if (typeof item.txt === "string" && item.txt) {
        // Skip timer-like content (e.g. "00:05:30", "5:30", countdown values)
        const trimmed = item.txt.trim();
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) continue;
        // Skip stage display field labels (e.g. "Current Slide", "Next Slide", "Clock")
        const acn = item.acn as string | undefined;
        if (acn === "tmr" || acn === "cs" || acn === "ns") continue;
        texts.push(trimmed);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }

  return "";
}

/**
 * Send a command to ProPresenter via its REST API (server-side to bypass CORS).
 * Commands: next, previous, clear
 */
export const sendProPresenterCommand = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(hostPortSchema.extend({ command: z.enum(["next", "previous", "clear"]) }), data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const { host, port, command } = data;
    const base = `http://${host}:${port || 1025}`;
    const timeout = 3000;

    // PP7 API endpoints vary by version — try multiple known paths and methods.
    const endpoints: { path: string; method: string }[] = (() => {
      switch (command) {
        case "next":
          return [
            { path: "/v1/trigger/next", method: "GET" },
            { path: "/v1/trigger/next", method: "POST" },
            { path: "/v1/presentation/active/focus/next", method: "GET" },
          ];
        case "previous":
          return [
            { path: "/v1/trigger/previous", method: "GET" },
            { path: "/v1/trigger/previous", method: "POST" },
            { path: "/v1/presentation/active/focus/previous", method: "GET" },
          ];
        case "clear":
          return [
            { path: "/v1/clear/layer/slide", method: "GET" },
            { path: "/v1/clear/layer/slide", method: "DELETE" },
            { path: "/v1/clear/slide", method: "GET" },
            { path: "/v1/clear/all", method: "GET" },
          ];
      }
    })();

    const errors: string[] = [];
    try {
      for (const { path, method } of endpoints) {
        try {
          const url = `${base}${path}`;
          const res = await fetch(url, {
            method,
            signal: AbortSignal.timeout(timeout),
          });
          // Any 2xx = success
          if (res.status >= 200 && res.status < 300) {
            return { ok: true };
          }
          errors.push(`${method} ${path} → ${res.status}`);
        } catch (e) {
          errors.push(`${method} ${path} → ${e}`);
          continue;
        }
      }
      return { ok: false, error: `No endpoint worked (port ${port}): ${errors.join("; ")}` };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

/**
 * Test ProPresenter connection by hitting known API endpoints.
 * Returns success if any endpoint responds.
 */
export const testProPresenterConnection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(hostPortSchema.extend({ apiPort: z.number().int().min(1).max(65535).optional() }), data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const { host, apiPort, port } = data;
    const timeout = 3000;

    // Try API port first (REST), then stage display port
    const ports = Array.from(new Set([apiPort || 1025, port].filter((p) => Number.isFinite(p) && p > 0)));
    const testEndpoints = [
      "/v1/stage/current_slide",
      "/v1/version",
      "/v1/status/slide",
      "/v1/presentation/active",
    ];

    for (const p of ports) {
      const base = `http://${host}:${p}`;
      for (const endpoint of testEndpoints) {
        try {
          const res = await fetch(`${base}${endpoint}`, {
            signal: AbortSignal.timeout(timeout),
          });
          if (res.ok || res.status === 401) {
            // 401 means PP is there but needs auth — still a valid connection
            return { ok: true };
          }
        } catch {
          continue;
        }
      }
    }

    return {
      ok: false,
      error: `Could not reach ProPresenter at ${host}. Make sure PP7 is running with Network enabled, and that this server can reach it. In production, use the ShowPilot Gateway bridge for local network access.`,
    };
  });

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
  .inputValidator((data: unknown) =>
    parseOrThrow(orgServiceDateSchema.extend({ slide: ppSlideSchema.nullable() }), data),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
    const prisma = getPrisma();
    const key = ppSlideKey(data.serviceDate);
    if (!data.slide) {
      // Upsert a "cleared" marker so kiosk sees null immediately on next poll
      // (deleteMany has a race with polling — kiosk might read stale data)
      await prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key } },
        update: { value: "null" },
        create: { orgId: data.orgId, key, value: "null" },
      });
    } else {
      await prisma.appSetting.upsert({
        where: { orgId_key: { orgId: data.orgId, key } },
        update: { value: JSON.stringify(data.slide) },
        create: { orgId: data.orgId, key, value: JSON.stringify(data.slide) },
      });
    }

    const bindings = env as unknown as RundownRelayEnv;
    if (bindings.RUNDOWN_RELAY) {
      try {
        const id = bindings.RUNDOWN_RELAY.idFromName(data.orgId);
        const stub = bindings.RUNDOWN_RELAY.get(id);
        await stub.fetch(
          new Request(`https://rundown.local/command?orgId=${encodeURIComponent(data.orgId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "pp-slide",
              payload: { slide: data.slide },
            }),
          })
        );
      } catch (err) {
        console.warn("[SP] PP slide relay sync failed:", err);
      }
    }

    return { ok: true };
  });

/**
 * Persist the ProPresenter-lyrics-on-timer flag for an org. Caller is
 * responsible for access control (server fn below; Companion endpoint).
 */
export async function setProPresenterStageDisplayForOrg(orgId: string, enabled: boolean): Promise<void> {
  const prisma = getPrisma();
  await prisma.appSetting.upsert({
    where: { orgId_key: { orgId, key: ppStageDisplayKey() } },
    update: { value: enabled ? "true" : "false" },
    create: { orgId, key: ppStageDisplayKey(), value: enabled ? "true" : "false" },
  });
}

/** Read the ProPresenter-lyrics-on-timer flag for an org. */
export async function getProPresenterStageDisplayForOrg(orgId: string): Promise<boolean> {
  const prisma = getPrisma();
  const row = await prisma.appSetting.findUnique({
    where: { orgId_key: { orgId, key: ppStageDisplayKey() } },
  });
  return row?.value === "true";
}

export const setProPresenterStageDisplay = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, enabled: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
    await setProPresenterStageDisplayForOrg(data.orgId, data.enabled);
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
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<SavedRundownMeta[]> => {
    await assertRundownEditAccess(data.orgId);
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
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, name: labelSchema, items: rawItemsSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
    const prisma = getPrisma();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const cleanItems = normalizeLegacyRundownItems(data.items).map((item) => ({
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
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, rundownId: idSchema }), data),
  )
  .handler(async ({ data }): Promise<RundownItem[] | null> => {
    await assertRundownEditAccess(data.orgId);
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
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, rundownId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertRundownEditAccess(data.orgId);
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
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<{ date: string; itemCount: number }[]> => {
    await assertRundownEditAccess(data.orgId);
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
