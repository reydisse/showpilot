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
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:view");
    const prisma = getPrisma();
    return await prisma.liveInput.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "asc" },
    });
  });

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

    // Delete from Cloudflare if we have a CF ID
    if (input.cfInputId) {
      try {
        const accountId = getAccountId();
        const headers = getCfHeaders();
        await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/live_inputs/${input.cfInputId}`,
          { method: "DELETE", headers }
        );
      } catch {
        // Continue with D1 deletion even if CF API fails
      }
    }

    await prisma.liveInput.delete({ where: { id: data.inputId } });
  });

export const getLiveInputStatus = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; inputId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "stream_health:view");
    const prisma = getPrisma();
    const input = await prisma.liveInput.findFirst({
      where: { id: data.inputId, orgId: data.orgId },
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

      // Update status in D1
      await prisma.liveInput.update({
        where: { id: data.inputId },
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
  });
