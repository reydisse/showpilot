import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { assertOrgPermission } from "@/lib/org-access";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import type { OntimeRuntimeState } from "@/types/ontime";
import {
  defaultOntimeTimer,
  fetchOntimeRuntimeState,
} from "@/lib/ontime-runtime";

async function readOntimeConfigForOrg(orgId: string) {
  const prisma = getPrisma();
  const [adapterSetting, urlSetting] = await Promise.all([
    prisma.appSetting.findUnique({ where: { orgId_key: { orgId, key: "rundown-adapter" } } }),
    prisma.appSetting.findUnique({ where: { orgId_key: { orgId, key: "ontime-url" } } }),
  ]);
  if (adapterSetting?.value !== "ontime" || !urlSetting?.value) return null;
  return { url: urlSetting.value.replace(/\/+$/, "") };
}

/**
 * Proxy OnTime runtime state through the CF Worker.
 * Fetches timer, current/next event, clock, and rundown from the OnTime HTTP API.
 */
export const getOntimeState = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }): Promise<OntimeRuntimeState> => {
    await assertOrgPermission(data.orgId, "show:view");
    const config = await readOntimeConfigForOrg(data.orgId);

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

    return fetchOntimeRuntimeState(config.url);
  });

/**
 * Test connectivity to the configured OnTime server.
 * Hits /api/poll (OnTime v3) so a generic web server doesn't pass as OnTime.
 */
export const testOntimeConnection = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
    await assertOrgPermission(data.orgId, "settings:integrations");
    const prisma = getPrisma();
    const urlSetting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "ontime-url" } },
    });
    if (!urlSetting?.value) {
      return { ok: false, error: "Set the OnTime server URL first" };
    }
    const baseUrl = urlSetting.value.replace(/\/+$/, "");
    try {
      const res = await fetch(`${baseUrl}/api/poll`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return { ok: false, error: `OnTime responded with HTTP ${res.status}` };
      }
      const body = (await res.json().catch(() => null)) as { payload?: unknown } | null;
      if (!body?.payload) {
        return { ok: false, error: "Unexpected response — is this an OnTime v3 server?" };
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        error:
          "Could not reach the OnTime server. It must be reachable from the internet (public URL or tunnel) — ShowPilot runs in the cloud.",
      };
    }
  });

const defaultTimer = defaultOntimeTimer;

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
