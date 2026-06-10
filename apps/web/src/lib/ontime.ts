import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import type { OntimeTimer, OntimeEvent, OntimeRuntimeState } from "@/types/ontime";

async function assertOrgAccess(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { id: true },
  });
  if (!member) throw new Error("Forbidden");
}

/**
 * Get the OnTime configuration for an org.
 * Reads from app_setting where the Settings page stores it.
 */
export const getOntimeConfig = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    const [adapterSetting, urlSetting] = await Promise.all([
      prisma.appSetting.findUnique({ where: { orgId_key: { orgId: data.orgId, key: "rundown-adapter" } } }),
      prisma.appSetting.findUnique({ where: { orgId_key: { orgId: data.orgId, key: "ontime-url" } } }),
    ]);
    if (adapterSetting?.value !== "ontime" || !urlSetting?.value) return null;
    // Normalize URL — strip trailing slash
    const url = urlSetting.value.replace(/\/+$/, "");
    return { url };
  });

/**
 * Proxy OnTime runtime state through the CF Worker.
 * Fetches timer, current/next event, clock, and rundown from the OnTime HTTP API.
 */
export const getOntimeState = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<OntimeRuntimeState> => {
    await assertOrgAccess(data.orgId);
    const config = await getOntimeConfig({ data: { orgId: data.orgId } });

    if (!config) {
      return {
        timer: defaultTimer,
        eventNow: null,
        eventNext: null,
        clock: 0,
        events: [],
        connected: false,
      };
    }

    const baseUrl = config.url;

    try {
      // OnTime v3 uses /api/poll for live state and /data/rundown for event list
      type PollResponse = {
        payload?: {
          timer?: Partial<OntimeTimer>;
          eventNow?: OntimeEvent | null;
          eventNext?: OntimeEvent | null;
          clock?: number;
        };
      };
      type RundownResponse =
        | OntimeEvent[]
        | { order?: string[]; entries?: Record<string, OntimeEvent> };
      const [pollRes, rundownRes] = (await Promise.all([
        fetch(`${baseUrl}/api/poll`).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch(`${baseUrl}/data/rundown`).then((r) => r.ok ? r.json() : null).catch(() => null),
      ])) as [PollResponse | null, RundownResponse | null];

      const poll = pollRes?.payload;
      if (!poll) {
        return { timer: defaultTimer, eventNow: null, eventNext: null, clock: 0, events: [], connected: false };
      }

      const timer: OntimeTimer = {
        addedTime: poll.timer?.addedTime ?? 0,
        current: poll.timer?.current ?? null,
        duration: poll.timer?.duration ?? null,
        elapsed: poll.timer?.elapsed ?? null,
        playback: poll.timer?.playback ?? "stop",
        startedAt: poll.timer?.startedAt ?? null,
        expectedFinish: poll.timer?.expectedFinish ?? null,
        finishedAt: poll.timer?.finishedAt ?? null,
      };
      const eventNow: OntimeEvent | null = poll.eventNow ?? null;
      const eventNext: OntimeEvent | null = poll.eventNext ?? null;
      const clock = poll.clock ?? Date.now();

      // Extract events from rundown — /data/rundown returns a flat array
      let events: OntimeEvent[] = [];
      if (rundownRes) {
        if (Array.isArray(rundownRes)) {
          events = rundownRes.filter(
            (e: { type: string; skip?: boolean }) => e?.type === "event" && !e?.skip
          );
        } else if (rundownRes.order && rundownRes.entries) {
          // Fallback: v3 format with order + entries map
          const entries = rundownRes.entries;
          events = rundownRes.order
            .map((id: string) => entries[id])
            .filter((e: { type: string; skip?: boolean }) => e?.type === "event" && !e?.skip);
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
