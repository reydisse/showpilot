import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { env } from "cloudflare:workers";
import { assertOrgPermission } from "@/lib/org-access";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";

// Destinations hold RTMP stream keys — every read/write must verify org
// membership + stream permission. Matches the pattern in src/lib/stream.ts.
/** Resolve a destination's org, then assert manage permission on it. */
async function assertDestinationAccess(id: string) {
  const prisma = getPrisma();
  const dest = await prisma.streamDestination.findUnique({
    where: { id },
    select: { orgId: true },
  });
  if (!dest) throw new Error("Destination not found");
  await assertOrgPermission(dest.orgId, "stream_health:manage");
}

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
const OUTPUT_OPERATION_STALE_MS = 30_000;

export function streamOutputOperationStartedAt(value: string): number | null {
  if (!value.startsWith(OUTPUT_PENDING_PREFIX)) return null;
  const startedAt = Number(value.split(":", 3)[1]);
  return Number.isFinite(startedAt) ? startedAt : null;
}

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
    return destinations.map(redactStreamDestination);
  });

export function redactStreamDestination<T extends { streamKey: string }>(
  destination: T,
): Omit<T, "streamKey"> & { hasStreamKey: boolean } {
  const { streamKey, ...safeDestination } = destination;
  return { ...safeDestination, hasStreamKey: streamKey.trim().length > 0 };
}

export function normalizeCfOutputStatus(output: { enabled?: boolean } | null | undefined): { status: string } {
  if (!output) return { status: "missing" };
  return { status: output.enabled === true ? "enabled" : "disabled" };
}

export const addStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        name: labelSchema,
        platform: z.string().min(1).max(50),
        rtmpUrl: z.string().regex(/^rtmps?:\/\//i).max(500),
        streamKey: z.string().min(1).max(500),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:manage");
    const prisma = getPrisma();
    return await prisma.streamDestination.create({
      data: {
        orgId: data.orgId,
        name: data.name,
        platform: data.platform,
        rtmpUrl: data.rtmpUrl,
        streamKey: data.streamKey,
        enabled: false,
      },
    });
  });

export const updateStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
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
    await assertDestinationAccess(data.id);
    const prisma = getPrisma();
    const destination = await prisma.streamDestination.findUnique({ where: { id: data.id } });
    if (!destination) throw new Error("Destination not found");
    const changesCredentials = (
      data.updates.rtmpUrl !== undefined && data.updates.rtmpUrl !== destination.rtmpUrl
    ) || Boolean(data.updates.streamKey?.trim());
    if (destination.cfOutputId && changesCredentials) {
      throw new Error("Disable this destination before changing its RTMP credentials");
    }
    const updates = { ...data.updates };
    if (!updates.streamKey?.trim()) delete updates.streamKey;
    return await prisma.streamDestination.update({
      where: { id: data.id },
      data: updates,
    });
  });

export const deleteStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ id: idSchema }), data))
  .handler(async ({ data }) => {
    await assertDestinationAccess(data.id);
    const destination = await getPrisma().streamDestination.findUnique({ where: { id: data.id }, select: { orgId: true } });
    if (!destination) throw new Error("Destination not found");
    await deleteStreamDestinationForOrg(destination.orgId, data.id);
  });

export const toggleStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ id: idSchema, enabled: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    await assertDestinationAccess(data.id);
    const destination = await getPrisma().streamDestination.findUnique({ where: { id: data.id }, select: { orgId: true } });
    if (!destination) throw new Error("Destination not found");
    return setStreamDestinationEnabledForOrg(destination.orgId, data.id, data.enabled);
  });

/** Tenant-scoped Stream Connect toggle shared by web, native, and future adapters. */
export async function setStreamDestinationEnabledForOrg(orgId: string, id: string, enabled: boolean) {
  const prisma = getPrisma();
  const destination = await prisma.streamDestination.findFirst({ where: { id, orgId } });
  if (!destination) throw new Error("Destination not found");

  // Selection is configuration only. Creating an enabled Cloudflare output
  // is reserved for the separately confirmed Go Live operation.
  if (!enabled && destination.cfOutputId.startsWith(OUTPUT_PENDING_PREFIX)) {
    return prisma.streamDestination.update({
      where: { id: destination.id },
      data: { enabled: false, cfOutputId: "", liveInputId: "" },
    });
  }
  if (!enabled && destination.cfOutputId) {
    const liveInput = await prisma.liveInput.findFirst({ where: { id: destination.liveInputId, orgId } });
    if (!liveInput?.cfInputId) throw new Error("The connected live input could not be found");
    await deleteCfOutput(liveInput.cfInputId, destination.cfOutputId);
    return prisma.streamDestination.update({
      where: { id: destination.id },
      data: { enabled: false, cfOutputId: "", liveInputId: "" },
    });
  }

  return prisma.streamDestination.update({ where: { id: destination.id }, data: { enabled } });
}

/** Disconnect first so deleting a row cannot orphan a paid provider output. */
export async function deleteStreamDestinationForOrg(orgId: string, id: string): Promise<void> {
  const prisma = getPrisma();
  const destination = await prisma.streamDestination.findFirst({ where: { id, orgId } });
  if (!destination) throw new Error("Destination not found");
  if (destination.cfOutputId) await setStreamDestinationEnabledForOrg(orgId, id, false);
  await prisma.streamDestination.delete({ where: { id } });
}

// ─── Cloudflare Stream Connect API ──────────────────────────

/** Create an output on a live input (simulcast to RTMP destination) */
async function createCfOutput(cfInputId: string, rtmpUrl: string, streamKey: string): Promise<string> {
  const accountId = getAccountId();
  const headers = getCfHeaders();

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs/${cfInputId}/outputs`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: rtmpUrl,
        streamKey,
        enabled: true,
      }),
    }
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { errors?: Array<{ message: string }> }).errors?.[0]?.message ||
        `Cloudflare API error: ${res.status}`
    );
  }

  const data = (await res.json()) as { result: { uid: string } };
  return data.result.uid;
}

async function listCfOutputs(cfInputId: string): Promise<Array<{ uid: string; url: string; streamKey: string; enabled?: boolean }>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${getAccountId()}/stream/live_inputs/${cfInputId}/outputs`,
    { headers: getCfHeaders() },
  );
  if (!response.ok) throw new Error(`Cloudflare API error: ${response.status}`);
  const data = await response.json() as { result?: Array<{ uid?: string; url?: string; streamKey?: string; enabled?: boolean }> };
  return (data.result ?? []).flatMap((output) => (
    output.uid && output.url && output.streamKey
      ? [{ uid: output.uid, url: output.url, streamKey: output.streamKey, enabled: output.enabled }]
      : []
  ));
}

async function setCfOutputEnabled(cfInputId: string, cfOutputId: string, enabled: boolean): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${getAccountId()}/stream/live_inputs/${cfInputId}/outputs/${cfOutputId}`,
    { method: "PUT", headers: getCfHeaders(), body: JSON.stringify({ enabled }) },
  );
  if (!response.ok) throw new Error(`Cloudflare API error: ${response.status}`);
}

async function connectDestinationOutput(
  prisma: ReturnType<typeof getPrisma>,
  destination: {
    id: string;
    orgId: string;
    enabled: boolean;
    cfOutputId: string;
    rtmpUrl: string;
    streamKey: string;
  },
  liveInput: { id: string; cfInputId: string },
): Promise<void> {
  if (destination.cfOutputId && !destination.cfOutputId.startsWith(OUTPUT_PENDING_PREFIX)) {
    await setCfOutputEnabled(liveInput.cfInputId, destination.cfOutputId, true);
    return;
  }

  const previousMarker = destination.cfOutputId;
  const startedAt = streamOutputOperationStartedAt(previousMarker);
  if (startedAt !== null && Date.now() - startedAt < OUTPUT_OPERATION_STALE_MS) {
    throw new Error("This destination is already being connected");
  }

  const marker = `${OUTPUT_PENDING_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
  const claimed = await prisma.streamDestination.updateMany({
    where: {
      id: destination.id,
      orgId: destination.orgId,
      enabled: true,
      cfOutputId: previousMarker,
    },
    data: { cfOutputId: marker, liveInputId: liveInput.id },
  });
  if (claimed.count !== 1) throw new Error("This destination changed while Go Live was starting");

  let outputId = "";
  try {
    const matching = (await listCfOutputs(liveInput.cfInputId)).filter(
      (output) => output.url === destination.rtmpUrl && output.streamKey === destination.streamKey,
    );
    outputId = matching[0]?.uid ?? await createCfOutput(
      liveInput.cfInputId,
      destination.rtmpUrl,
      destination.streamKey,
    );
    await setCfOutputEnabled(liveInput.cfInputId, outputId, true);
    for (const duplicate of matching.slice(1)) await deleteCfOutput(liveInput.cfInputId, duplicate.uid);

    const stored = await prisma.streamDestination.updateMany({
      where: { id: destination.id, orgId: destination.orgId, enabled: true, cfOutputId: marker },
      data: { cfOutputId: outputId, liveInputId: liveInput.id },
    });
    if (stored.count !== 1) {
      await deleteCfOutput(liveInput.cfInputId, outputId);
      throw new Error("Destination selection changed while Go Live was starting");
    }
  } catch (error) {
    // The durable marker keeps the operation recoverable. If the provider
    // output exists but D1 failed, disable it so an uncertain request cannot
    // continue broadcasting; a later retry adopts it by exact credentials.
    if (outputId) await setCfOutputEnabled(liveInput.cfInputId, outputId, false).catch(() => {});
    throw error;
  }
}

/** Delete an output from a live input */
async function deleteCfOutput(cfInputId: string, cfOutputId: string): Promise<void> {
  const accountId = getAccountId();
  const headers = getCfHeaders();

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs/${cfInputId}/outputs/${cfOutputId}`,
    { method: "DELETE", headers }
  );
  if (!response.ok) {
    if (response.status === 404) return;
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { errors?: Array<{ message: string }> }).errors?.[0]?.message
        || `Cloudflare API error: ${response.status}`,
    );
  }
}

/** Check Stream Connect output status for all connected destinations */
export const getOutputStatuses = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:view");
    const prisma = getPrisma();
    const destinations = await prisma.streamDestination.findMany({
      where: { orgId: data.orgId, cfOutputId: { not: "" } },
    });

    if (destinations.length === 0) return {};

    const accountId = getAccountId();
    const headers = getCfHeaders();
    const statuses: Record<string, { status: string; error?: string }> = {};

    for (const dest of destinations) {
      const liveInput = await prisma.liveInput.findFirst({
        where: { id: dest.liveInputId, orgId: data.orgId },
      });
      if (!liveInput?.cfInputId || !dest.cfOutputId) {
        statuses[dest.id] = { status: "unknown" };
        continue;
      }

      try {
        // Fetch the specific output to check its connection status
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs/${liveInput.cfInputId}/outputs`,
          { headers }
        );

        if (!res.ok) {
          statuses[dest.id] = { status: "unknown" };
          continue;
        }

        const cfData = (await res.json()) as {
          result: Array<{
            uid: string;
            url: string;
            enabled?: boolean;
          }>;
        };

        const output = cfData.result?.find((o) => o.uid === dest.cfOutputId);
        if (!output) {
          statuses[dest.id] = { status: "missing" };
          continue;
        }

        // Cloudflare's documented output contract exposes configuration and
        // enabled state, not destination connection health. Never infer Live
        // or Connecting from fields the provider does not promise.
        statuses[dest.id] = normalizeCfOutputStatus(output);
      } catch {
        statuses[dest.id] = { status: "unknown" };
      }
    }

    return statuses;
  });

// ─── Reusable cores (no session auth — caller gates access) ──
//
// Shared by the session-gated server fns above and the Companion stream
// endpoints (COMP-5). The Multi-Platform page selects `inputs[0]` as the
// active live input; resolveOrgLiveInput mirrors that.

/** The org's active live input (oldest), or null when none is configured. */
export async function resolveOrgLiveInput(
  orgId: string,
): Promise<{ id: string; cfInputId: string } | null> {
  const prisma = getPrisma();
  const li = await prisma.liveInput.findFirst({
    where: { orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true, cfInputId: true },
  });
  if (!li || !li.cfInputId) return null;
  return { id: li.id, cfInputId: li.cfInputId };
}

/** Connect all enabled destinations to a live input; returns per-dest result. */
export async function connectDestinationsForOrg(
  orgId: string,
  liveInputId: string,
): Promise<{ id: string; success: boolean; error?: string }[]> {
  const prisma = getPrisma();
  const liveInput = await prisma.liveInput.findFirst({
    where: { id: liveInputId, orgId },
  });
  if (!liveInput?.cfInputId) throw new Error("Live input not found");

  const destinations = await prisma.streamDestination.findMany({
    where: { orgId, enabled: true },
  });

  const results: { id: string; success: boolean; error?: string }[] = [];

  for (const dest of destinations) {
    try {
      await connectDestinationOutput(prisma, dest, liveInput);
      results.push({ id: dest.id, success: true });
    } catch (err) {
      results.push({ id: dest.id, success: false, error: String(err) });
    }
  }

  return results;
}

/** Disconnect every connected output for an org. */
export async function disconnectAllForOrg(
  orgId: string,
): Promise<Array<{ id: string; success: boolean; error?: string }>> {
  const prisma = getPrisma();
  const destinations = await prisma.streamDestination.findMany({
    where: { orgId, cfOutputId: { not: "" } },
  });

  const results: Array<{ id: string; success: boolean; error?: string }> = [];
  for (const dest of destinations) {
    try {
      if (dest.cfOutputId.startsWith(OUTPUT_PENDING_PREFIX)) {
        throw new Error(`${dest.name} is still reconciling a prior Go Live request`);
      }
      const liveInput = await prisma.liveInput.findFirst({
        where: { id: dest.liveInputId, orgId },
      });
      if (!liveInput?.cfInputId || !dest.cfOutputId) {
        throw new Error(`The connected live input for ${dest.name} could not be found`);
      }
      await deleteCfOutput(liveInput.cfInputId, dest.cfOutputId);
      await prisma.streamDestination.update({
        where: { id: dest.id },
        data: { cfOutputId: "", liveInputId: "" },
      });
      results.push({ id: dest.id, success: true });
    } catch (error) {
      results.push({ id: dest.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

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
    connected: destinations.filter((d) => d.cfOutputId && d.cfOutputId.length > 0).length,
  };
}

/** Connect all enabled destinations to a specific live input */
export const connectDestinationsToInput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, liveInputId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:manage");
    return connectDestinationsForOrg(data.orgId, data.liveInputId);
  });

/** Disconnect all outputs from a live input */
export const disconnectAllDestinations = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:manage");
    return disconnectAllForOrg(data.orgId);
  });
