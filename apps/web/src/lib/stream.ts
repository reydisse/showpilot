import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";
import { env } from "cloudflare:workers";
import { assertOrgPermission } from "@/lib/org-access";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";
import { normalizeLiveInputStatus } from "@/lib/stream-health";

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

// ─── Live Inputs ────────────────────────────────────────────

export const getLiveInputs = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, includeCredentials: z.boolean().optional() }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, data.includeCredentials ? "stream_health:manage" : "stream_health:view");
    const prisma = getPrisma();
    const inputs = await prisma.liveInput.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
    return inputs.map((input) => redactLiveInput(input, data.includeCredentials));
  });

export function redactLiveInput<T extends { rtmpKey: string }>(
  input: T,
  includeCredentials = false,
): Omit<T, "rtmpKey"> & { hasRtmpKey: boolean; rtmpKey?: string } {
  const { rtmpKey, ...safeInput } = input;
  return {
    ...safeInput,
    hasRtmpKey: rtmpKey.trim().length > 0,
    ...(includeCredentials ? { rtmpKey } : {}),
  };
}

export const createLiveInput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, name: labelSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:manage");
    const accountId = getAccountId();
    const headers = getCfHeaders();

    // Create live input on Cloudflare Stream
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          meta: { name: data.name },
          recording: { mode: "off" },
        }),
      }
    );

    if (!cfRes.ok) {
      const body = await cfRes.json().catch(() => ({}));
      throw new Error(
        (body as { errors?: Array<{ message: string }> }).errors?.[0]?.message ||
          `Cloudflare API error: ${cfRes.status}`
      );
    }

    const cfData = (await cfRes.json()) as {
      result: {
        uid: string;
        rtmps: { url: string; streamKey: string };
        srt: { url: string };
      };
    };
    const input = cfData.result;

    // Save to D1
    const prisma = getPrisma();
    return await prisma.liveInput.create({
      data: {
        orgId: data.orgId,
        cfInputId: input.uid,
        cfInputUid: input.uid,
        name: data.name,
        rtmpUrl: input.rtmps.url,
        rtmpKey: input.rtmps.streamKey,
        srtUrl: input.srt?.url ?? "",
        status: "idle",
      },
    });
  });

export const deleteLiveInput = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, inputId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:manage");
    const prisma = getPrisma();
    const input = await prisma.liveInput.findFirst({
      where: { id: data.inputId, orgId: data.orgId },
    });
    if (!input) throw new Error("Live input not found");
    const connectedOutput = await prisma.streamDestination.findFirst({
      where: { orgId: data.orgId, liveInputId: input.id, cfOutputId: { not: "" } },
      select: { id: true },
    });
    if (connectedOutput) {
      throw new Error("Disconnect every destination from this live input before deleting it");
    }
    if (input.cfInputId) await deleteCfLiveInput(input.cfInputId);
    await prisma.liveInput.delete({ where: { id: data.inputId } });
  });

export async function deleteCfLiveInput(cfInputId: string): Promise<void> {
  const accountId = getAccountId();
  const headers = getCfHeaders();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs/${cfInputId}`,
    { method: "DELETE", headers },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { errors?: Array<{ message: string }> }).errors?.[0]?.message
        || `Cloudflare API error: ${response.status}`,
    );
  }
}

export const getLiveInputStatus = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; inputId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:view");
    return getLiveInputStatusForOrg(data.orgId, data.inputId);
  });

/** Provider-backed input health shared by web and the separately authorized mobile API. */
export async function getLiveInputStatusForOrg(orgId: string, inputId: string) {
  const prisma = getPrisma();
  const input = await prisma.liveInput.findFirst({
    where: { id: inputId, orgId },
  });
  if (!input || !input.cfInputId) return null;

  try {
    const accountId = getAccountId();
    const headers = getCfHeaders();
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs/${input.cfInputId}`,
      { headers }
    );

    if (!cfRes.ok) return {
      inputId: input.id,
      status: "unknown",
      providerStatus: "api_error",
      checkedAt: new Date().toISOString(),
      error: `Cloudflare status check failed (${cfRes.status})`,
    };

    const cfData = (await cfRes.json()) as {
      result: {
        status?: string | { current?: { state?: string; reason?: string } } | null;
        enabled?: boolean;
      };
    };

    const rawStatus = typeof cfData.result?.status === "string"
      ? cfData.result.status
      : cfData.result?.status?.current?.state ?? "idle";
    const reason = typeof cfData.result?.status === "object"
      ? cfData.result?.status?.current?.reason
      : undefined;
    const normalizedStatus = normalizeLiveInputStatus(rawStatus, cfData.result?.enabled !== false);

    // Keep the cached value useful for dashboards that do not call the provider.
    await prisma.liveInput.update({
      where: { id: inputId },
      data: { status: normalizedStatus },
    });

    return {
      inputId: input.id,
      status: normalizedStatus,
      providerStatus: rawStatus,
      checkedAt: new Date().toISOString(),
      error: reason ?? (normalizedStatus === "error" ? rawStatus.replaceAll("_", " ") : undefined),
    };
  } catch (error) {
    return {
      inputId: input.id,
      status: "unknown",
      providerStatus: "unreachable",
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Status unavailable",
    };
  }
}
