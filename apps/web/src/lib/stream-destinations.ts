import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { env } from "cloudflare:workers";

function getCfHeaders() {
  const token = (env as Record<string, string>).CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN not configured");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function getAccountId() {
  const id = (env as Record<string, string>).CLOUDFLARE_ACCOUNT_ID;
  if (!id) throw new Error("CLOUDFLARE_ACCOUNT_ID not configured");
  return id;
}

// ─── Stream Destinations ────────────────────────────────────

export const getStreamDestinations = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.streamDestination.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
  });

export const addStreamDestination = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      name: string;
      platform: string;
      rtmpUrl?: string;
      streamKey?: string;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.streamDestination.create({
      data: {
        orgId: data.orgId,
        name: data.name,
        platform: data.platform,
        rtmpUrl: data.rtmpUrl ?? "",
        streamKey: data.streamKey ?? "",
      },
    });
  });

export const updateStreamDestination = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      id: string;
      updates: Partial<{
        name: string;
        platform: string;
        rtmpUrl: string;
        streamKey: string;
        enabled: boolean;
      }>;
    }) => data
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.streamDestination.update({
      where: { id: data.id },
      data: data.updates,
    });
  });

export const deleteStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    await prisma.streamDestination.delete({ where: { id: data.id } });
  });

export const toggleStreamDestination = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; enabled: boolean }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const dest = await prisma.streamDestination.findUnique({ where: { id: data.id } });
    if (!dest) throw new Error("Destination not found");

    if (data.enabled && !dest.cfOutputId) {
      // Enabling: create a Stream Connect output on the live input
      const liveInput = await prisma.liveInput.findFirst({
        where: { orgId: dest.orgId },
        orderBy: { createdAt: "asc" },
      });
      if (liveInput?.cfInputId) {
        try {
          const outputId = await createCfOutput(liveInput.cfInputId, dest.rtmpUrl, dest.streamKey);
          return await prisma.streamDestination.update({
            where: { id: data.id },
            data: { enabled: true, cfOutputId: outputId, liveInputId: liveInput.id },
          });
        } catch (err) {
          // Still enable locally even if CF fails
          console.error("[Stream Connect] Failed to create output:", err);
        }
      }
    } else if (!data.enabled && dest.cfOutputId) {
      // Disabling: delete the Stream Connect output
      const liveInput = await prisma.liveInput.findFirst({
        where: { id: dest.liveInputId, orgId: dest.orgId },
      });
      if (liveInput?.cfInputId) {
        try {
          await deleteCfOutput(liveInput.cfInputId, dest.cfOutputId);
        } catch (err) {
          console.error("[Stream Connect] Failed to delete output:", err);
        }
      }
      return await prisma.streamDestination.update({
        where: { id: data.id },
        data: { enabled: false, cfOutputId: "", liveInputId: "" },
      });
    }

    return await prisma.streamDestination.update({
      where: { id: data.id },
      data: { enabled: data.enabled },
    });
  });

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

/** Delete an output from a live input */
async function deleteCfOutput(cfInputId: string, cfOutputId: string): Promise<void> {
  const accountId = getAccountId();
  const headers = getCfHeaders();

  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs/${cfInputId}/outputs/${cfOutputId}`,
    { method: "DELETE", headers }
  );
}

/** Check Stream Connect output status for all connected destinations */
export const getOutputStatuses = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
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
            status: {
              current: {
                state: string;
                reason?: string;
              };
            } | null;
          }>;
        };

        const output = cfData.result?.find((o) => o.uid === dest.cfOutputId);
        if (!output) {
          statuses[dest.id] = { status: "missing" };
          continue;
        }

        const state = output.status?.current?.state ?? "idle";
        const reason = output.status?.current?.reason;
        // CF Stream Connect output states: "connected", "reconnecting", "reconnected", "idle", "disconnected"
        statuses[dest.id] = {
          status: state,
          error: reason && state !== "connected" ? reason : undefined,
        };
      } catch {
        statuses[dest.id] = { status: "unknown" };
      }
    }

    return statuses;
  });

/** Connect all enabled destinations to a specific live input */
export const connectDestinationsToInput = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; liveInputId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const liveInput = await prisma.liveInput.findFirst({
      where: { id: data.liveInputId, orgId: data.orgId },
    });
    if (!liveInput?.cfInputId) throw new Error("Live input not found");

    const destinations = await prisma.streamDestination.findMany({
      where: { orgId: data.orgId, enabled: true },
    });

    const results: { id: string; success: boolean; error?: string }[] = [];

    for (const dest of destinations) {
      if (dest.cfOutputId) {
        results.push({ id: dest.id, success: true }); // Already connected
        continue;
      }
      try {
        const outputId = await createCfOutput(liveInput.cfInputId, dest.rtmpUrl, dest.streamKey);
        await prisma.streamDestination.update({
          where: { id: dest.id },
          data: { cfOutputId: outputId, liveInputId: liveInput.id },
        });
        results.push({ id: dest.id, success: true });
      } catch (err) {
        results.push({ id: dest.id, success: false, error: String(err) });
      }
    }

    return results;
  });

/** Disconnect all outputs from a live input */
export const disconnectAllDestinations = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const destinations = await prisma.streamDestination.findMany({
      where: { orgId: data.orgId, cfOutputId: { not: "" } },
    });

    for (const dest of destinations) {
      const liveInput = await prisma.liveInput.findFirst({
        where: { id: dest.liveInputId, orgId: data.orgId },
      });
      if (liveInput?.cfInputId && dest.cfOutputId) {
        try {
          await deleteCfOutput(liveInput.cfInputId, dest.cfOutputId);
        } catch {
          // Continue
        }
      }
      await prisma.streamDestination.update({
        where: { id: dest.id },
        data: { cfOutputId: "", liveInputId: "" },
      });
    }
  });
