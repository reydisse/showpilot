import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import { env } from "cloudflare:workers";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";

async function getOrgMemberRole(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role) throw new Error("Forbidden");
  return role;
}

async function assertOrgPermission(orgId: string, permission: "stream_health:view" | "stream_health:manage") {
  const role = await getOrgMemberRole(orgId);
  if (!hasPermission(role, permission)) throw new Error("Forbidden");
}

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
  .inputValidator((data: { orgId: string; name: string }) => data)
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
  .inputValidator((data: { orgId: string; inputId: string }) => data)
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

      if (!cfRes.ok) return { ...input, status: "idle" };

      const cfData = (await cfRes.json()) as {
        result: {
          status: { current: { state: string } } | null;
        };
      };

      const state = cfData.result?.status?.current?.state ?? "idle";
      const normalizedStatus =
        state === "connected"
          ? "connected"
          : state === "live_streaming"
            ? "streaming"
            : "idle";

      // Update status in D1
      await prisma.liveInput.update({
        where: { id: data.inputId },
        data: { status: normalizedStatus },
      });

      return { ...input, status: normalizedStatus };
    } catch {
      return input;
    }
  });
