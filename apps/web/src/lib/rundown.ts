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

/**
 * Server-side proxy to fetch current slide from PP7 REST API.
 * Runs on the server to bypass browser CORS restrictions.
 * Tries multiple PP7 API endpoints since versions differ.
 */
export const pollProPresenterSlide = createServerFn({ method: "GET" })
  .inputValidator((data: { host: string; port: number }) => data)
  .handler(async ({ data }): Promise<PPSlidePayload | null> => {
    const { host, port } = data;
    const base = `http://${host}:${port}`;
    const timeout = 2000;

    // Try multiple PP7 REST endpoints in order of likelihood
    // Note: /v1/stage/layout_map returns stage display fields including timers,
    // so we try slide-specific endpoints first.
    const endpoints = [
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
  .inputValidator((data: { host: string; port: number; command: "next" | "previous" | "clear" }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const { host, port, command } = data;
    const base = `http://${host}:${port}`;
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
  .inputValidator((data: { host: string; port: number; apiPort?: number }) => data)
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    const { host, apiPort, port } = data;
    const timeout = 3000;

    // Try API port first (REST), then stage display port
    const ports = apiPort && apiPort !== port ? [apiPort, port] : [port];
    const testEndpoints = [
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
  .inputValidator((data: { orgId: string; serviceDate: string; slide: PPSlidePayload | null }) => data)
  .handler(async ({ data }) => {
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
