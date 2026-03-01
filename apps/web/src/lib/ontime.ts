import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import type { OntimeTimer, OntimeEvent, OntimeRuntimeState } from "@/types/ontime";

/**
 * Get the OnTime device configuration for an org.
 * Returns the base URL or null if no OnTime device is configured.
 */
export const getOntimeConfig = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const device = await prisma.device.findFirst({
      where: { orgId: data.orgId, adapterType: "ontime", enabled: true },
    });
    if (!device) return null;
    const settings = JSON.parse(device.settings || "{}");
    const host = settings.host || "localhost";
    const port = settings.port || 4001;
    return { url: `http://${host}:${port}` };
  });

/**
 * Proxy OnTime runtime state through the CF Worker.
 * Fetches timer, current/next event, clock, and rundown from the OnTime HTTP API.
 */
export const getOntimeState = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<OntimeRuntimeState> => {
    const prisma = getPrisma();
    const device = await prisma.device.findFirst({
      where: { orgId: data.orgId, adapterType: "ontime", enabled: true },
    });

    if (!device) {
      return {
        timer: defaultTimer,
        eventNow: null,
        eventNext: null,
        clock: 0,
        events: [],
        connected: false,
      };
    }

    const settings = JSON.parse(device.settings || "{}");
    const host = settings.host || "localhost";
    const port = settings.port || 4001;
    const baseUrl = `http://${host}:${port}`;

    try {
      const [timerRes, nowRes, nextRes, rundownRes] = await Promise.all([
        fetch(`${baseUrl}/api/v1/timer`).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch(`${baseUrl}/api/v1/event/now`).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch(`${baseUrl}/api/v1/event/next`).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch(`${baseUrl}/api/v1/rundown`).then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);

      const timer: OntimeTimer = timerRes ?? defaultTimer;
      const eventNow: OntimeEvent | null = nowRes ?? null;
      const eventNext: OntimeEvent | null = nextRes ?? null;
      const clock = Date.now(); // Use server time as clock reference

      // Extract events from rundown
      let events: OntimeEvent[] = [];
      if (rundownRes) {
        // OnTime v3 rundown format: { order: [...ids], entries: { id: entry } }
        if (rundownRes.order && rundownRes.entries) {
          events = rundownRes.order
            .map((id: string) => rundownRes.entries[id])
            .filter((e: { type: string; skip?: boolean }) => e?.type === "event" && !e?.skip);
        } else if (Array.isArray(rundownRes)) {
          // OnTime v2 format: array of entries
          events = rundownRes.filter((e: { type: string; skip?: boolean }) => e?.type === "event" && !e?.skip);
        }
      }

      return { timer, eventNow, eventNext, clock, events, connected: true };
    } catch {
      return {
        timer: defaultTimer,
        eventNow: null,
        eventNext: null,
        clock: 0,
        events: [],
        connected: false,
      };
    }
  });

const defaultTimer: OntimeTimer = {
  addedTime: 0,
  current: null,
  duration: null,
  elapsed: null,
  playback: "stop",
  startedAt: null,
  expectedFinish: null,
  finishedAt: null,
};

// ─── Formatting Utilities ─────────────────────────────────────

/** Format milliseconds from midnight to a readable time string (h:mm AM/PM). */
export function formatOntimeTime(ms: number | null): string {
  if (ms === null || ms === undefined) return "--:--";
  const totalSeconds = Math.floor(ms / 1000);
  let hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
}

/** Format a duration in ms to mm:ss or h:mm:ss. */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "--:--";
  const negative = ms < 0;
  const abs = Math.abs(ms);
  const totalSeconds = Math.floor(abs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const prefix = negative ? "-" : "";
  if (hours > 0) {
    return `${prefix}${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${prefix}${minutes}:${seconds.toString().padStart(2, "0")}`;
}
