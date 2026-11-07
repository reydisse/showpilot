import { getD1 } from "./d1";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { env } from "cloudflare:workers";
import { assertOrgPermission } from "@/lib/org-access";
import { saveStreamDestinationForOrg } from "./stream-destination-write.server";
import { z } from "zod";
import { runStreamOutputCommand, outputVersions, type OutputCommandOptions } from "./stream-output-command.server";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";

// Destinations hold RTMP stream keys — every read/write must verify org
// membership + stream permission. Matches the pattern in src/lib/stream.ts.
function getCfHeaders() {
  const token: string | undefined = env.CLOUDFLARE_STREAM_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_STREAM_API_TOKEN not configured");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function getAccountId() {
  const id: string | undefined = env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) throw new Error("CLOUDFLARE_ACCOUNT_ID not configured");
  return id;
}

const OUTPUT_PENDING_PREFIX = "pending:";
// ─── Stream Destinations ────────────────────────────────────

export const getStreamDestinations = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:view");
    const prisma = getPrisma();
    const destinations = await prisma.streamDestination.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
    const versions = await outputVersions(data.orgId, destinations);
    return destinations.map(destination => ({ ...redactStreamDestination(destination), outputVersion: versions[destination.id] ?? "" }));
  });

export function redactStreamDestination<T extends { streamKey: string }>(
  destination: T,
): Omit<T, "streamKey"> & { hasStreamKey: boolean } {
  const { streamKey, ...safeDestination } = destination;
  return { ...safeDestination, hasStreamKey: streamKey.trim().length > 0 };
}

export type StreamOutputStatus =
  | { status: "enabled" | "disabled" | "missing" | "unconfirmed" }
  | { status: "unknown"; error: string };

export function normalizeCfOutputStatus(output: { enabled?: boolean } | null | undefined): StreamOutputStatus {
  if (!output) return { status: "missing" };
  if (typeof output.enabled !== "boolean") return { status: "unknown", error: "The provider did not report whether this output is enabled." };
  return { status: output.enabled ? "enabled" : "disabled" };
}

const outputTargetsSchema = z.array(z.object({ id: idSchema, version: z.string().max(128) })).max(100).optional();
const destinationRequestIdSchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).optional();

export const addStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        requestId: destinationRequestIdSchema,
        name: labelSchema,
        platform: z.string().min(1).max(50),
        rtmpUrl: z.string().regex(/^rtmps?:\/\//i).max(500),
        streamKey: z.string().min(1).max(500),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "stream_health:manage");
    const { orgId, requestId, ...fields } = data;
    const id = await saveStreamDestinationForOrg({ orgId, actorId: user.id, requestId, kind: "create", fields });
    const destination = await getPrisma().streamDestination.findFirst({ where: { id, orgId } });
    if (!destination) throw new Error("The saved destination was removed. Retrying will not recreate it.");
    return redactStreamDestination(destination);
  });

export const updateStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        requestId: destinationRequestIdSchema,
        id: idSchema,
        updates: z
          .object({
            name: labelSchema,
            platform: z.string().min(1).max(50),
            rtmpUrl: z.string().regex(/^rtmps?:\/\//i).max(500),
            streamKey: z.string().max(500),
          })
          .partial(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "stream_health:manage");
    await saveStreamDestinationForOrg({ orgId: data.orgId, actorId: user.id, requestId: data.requestId, kind: "update", id: data.id, fields: data.updates });
    const destination = await getPrisma().streamDestination.findFirst({ where: { id: data.id, orgId: data.orgId } });
    if (!destination) throw new Error("The saved destination was removed. Retrying will not recreate it.");
    return redactStreamDestination(destination);
  });

export const deleteStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ id: idSchema, orgId: idSchema.optional(), requestId: destinationRequestIdSchema }), data))
  .handler(async ({ data }) => {
    const orgId = data.orgId ?? (await getPrisma().streamDestination.findUnique({ where: { id: data.id }, select: { orgId: true } }))?.orgId;
    if (!orgId) throw new Error("Destination not found");
    const { user } = await assertOrgPermission(orgId, "stream_health:manage");
    await deleteStreamDestinationForOrg(orgId, data.id, { actorId: user.id, requestId: data.requestId });
  });

export const toggleStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ id: idSchema, orgId: idSchema.optional(), requestId: destinationRequestIdSchema, enabled: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    const orgId = data.orgId ?? (await getPrisma().streamDestination.findUnique({ where: { id: data.id }, select: { orgId: true } }))?.orgId;
    if (!orgId) throw new Error("Destination not found");
    const { user } = await assertOrgPermission(orgId, "stream_health:manage");
    return redactStreamDestination(await setStreamDestinationEnabledForOrg(orgId, data.id, data.enabled, { actorId: user.id, requestId: data.requestId }));
  });

/** Selection never starts a broadcast. All provider mutations share durable intent. */
export const setStreamDestinationEnabledForOrg = createServerOnlyFn(async (orgId: string, id: string, enabled: boolean, options: OutputCommandOptions = {}) => {
  const results = await runStreamOutputCommand({ ...options, orgId, destinationId: id, action: enabled ? "select" : "disable" });
  const failure = results.find(result => !result.success);
  if (failure) throw new Error(failure.error);
  const destination = await getPrisma().streamDestination.findFirst({ where: { id, orgId } });
  if (!destination) throw new Error("The destination was removed. Retrying will not recreate it.");
  return destination;
});

export const deleteStreamDestinationForOrg = createServerOnlyFn(async (orgId: string, id: string, options: OutputCommandOptions = {}): Promise<void> => {
  const results = await runStreamOutputCommand({ ...options, orgId, destinationId: id, action: "delete" });
  const failure = results.find(result => !result.success);
  if (failure) throw new Error(failure.error);
});

const outputListSchema = z.object({
  success: z.literal(true).optional(),
  result: z.array(z.object({ uid: z.string().min(1), enabled: z.boolean().optional() })),
});

async function readCfOutputStates(cfInputId: string): Promise<z.infer<typeof outputListSchema>["result"]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${getAccountId()}/stream/live_inputs/${encodeURIComponent(cfInputId)}/outputs`,
          { headers: getCfHeaders(), signal: controller.signal },
        );
        if (!response.ok) throw new Error("Output status is unavailable. Retry to check the provider.");
        const parsed = outputListSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("The provider returned an unreadable output status. Retry to check again.");
        return parsed.data.result;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Output status did not arrive within five seconds. Retry to check the provider."));
        }, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Read each input once. A slow or failed provider read cannot fabricate live state. */
export const getOutputStatuses = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<Record<string, StreamOutputStatus>> => {
    await assertOrgPermission(data.orgId, "stream_health:view");
    const prisma = getPrisma();
    const destinations = await prisma.streamDestination.findMany({
      where: { orgId: data.orgId, cfOutputId: { not: "" } },
      select: { id: true, cfOutputId: true, liveInputId: true },
    });
    if (!destinations.length) return {};
    const inputs = await prisma.liveInput.findMany({
      where: { orgId: data.orgId, id: { in: [...new Set(destinations.map(destination => destination.liveInputId))] } },
      select: { id: true, cfInputId: true },
    });
    const states: Record<string, StreamOutputStatus> = {};
    const groups = new Map<string, typeof destinations>();
    for (const destination of destinations) {
      if (destination.cfOutputId.startsWith(OUTPUT_PENDING_PREFIX)) {
        states[destination.id] = { status: "unconfirmed" };
        continue;
      }
      const input = inputs.find(input => input.id === destination.liveInputId);
      if (!input?.cfInputId) {
        states[destination.id] = { status: "unknown", error: "The configured live input is unavailable. Review the saved destination." };
        continue;
      }
      const group = groups.get(input.cfInputId) ?? [];
      group.push(destination);
      groups.set(input.cfInputId, group);
    }
    await Promise.all([...groups].map(async ([cfInputId, group]) => {
      try {
        const outputs = await readCfOutputStates(cfInputId);
        for (const destination of group) states[destination.id] = normalizeCfOutputStatus(outputs.find(output => output.uid === destination.cfOutputId));
      } catch {
        // Do not forward arbitrary provider/network text, which may contain credentials.
        for (const destination of group) states[destination.id] = { status: "unknown", error: "Could not confirm this output's status. Retry to check the provider." };
      }
    }));
    return states;
  });

// ─── Reusable cores (no session auth — caller gates access) ──
//
// Shared by the session-gated server fns above and the Companion stream
// endpoints (COMP-5). The Multi-Platform page selects `inputs[0]` as the
// active live input; resolveOrgLiveInput mirrors that.

/** The org's active live input (oldest), or null when none is configured. */
export const resolveOrgLiveInput = createServerOnlyFn(async (
  orgId: string,
): Promise<{ id: string; cfInputId: string } | null> => {
  return getD1().prepare(`SELECT i.id,i.cfInputId FROM live_input i WHERE i.orgId=? AND i.cfInputId<>'' AND i.cfInputId NOT LIKE 'pending:%'
    AND NOT EXISTS(SELECT 1 FROM stream_input_lifecycle l WHERE l.orgId=i.orgId AND l.inputId=i.id AND (l.desired<>'active' OR l.phase<>'ready'))
    ORDER BY i.createdAt ASC,i.id ASC LIMIT 1`).bind(orgId).first<{id:string;cfInputId:string}>();
});

/** Caller gates current authority; receipt replay does not bypass that check. */
export const connectDestinationsForOrg = createServerOnlyFn(async (
  orgId: string, liveInputId: string, options: OutputCommandOptions = {},
) => {
  const liveInput = await getPrisma().liveInput.findFirst({ where: { id: liveInputId, orgId } });
  if (!liveInput?.cfInputId) throw new Error("Live input not found");
  return runStreamOutputCommand({ ...options, orgId, liveInputId, action: "live" });
});

export const disconnectAllForOrg = createServerOnlyFn(async (orgId: string, options: OutputCommandOptions = {}) =>
  runStreamOutputCommand({ ...options, orgId, action: "stop" }),
);

/**
 * Lightweight simulcast status for button feedback: how many enabled
 * destinations currently have a Stream Connect output wired (`connected`),
 * out of the enabled total. Avoids a per-output CF API round-trip.
 */
export async function getStreamStatusForOrg(
  orgId: string,
): Promise<{ connected: number; total: number }> {
  const prisma = getPrisma();
  const destinations = await prisma.streamDestination.findMany({
    where: { orgId, enabled: true },
    select: { cfOutputId: true },
  });
  return {
    total: destinations.length,
    connected: destinations.filter((d) => d.cfOutputId && !d.cfOutputId.startsWith(OUTPUT_PENDING_PREFIX)).length,
  };
}

/** Connect all enabled destinations to a specific live input */
export const connectDestinationsToInput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, liveInputId: idSchema, requestId: destinationRequestIdSchema, targets: outputTargetsSchema }), data),
  )
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "stream_health:manage");
    return connectDestinationsForOrg(data.orgId, data.liveInputId, { actorId: user.id, requestId: data.requestId, targets: data.targets });
  });

/** Disconnect all outputs from a live input */
export const disconnectAllDestinations = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, requestId: destinationRequestIdSchema, targets: outputTargetsSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "stream_health:manage");
    return disconnectAllForOrg(data.orgId, { actorId: user.id, requestId: data.requestId, targets: data.targets });
  });
