import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getPrisma } from "@/lib/db";
import { checkPermission } from "@/middleware/withPermission";
import type { Permission } from "@/lib/permissions";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import {
  hashRundownPin,
  isHashedRundownPin,
  verifyStoredRundownPin,
} from "@/lib/rundown-pin-crypto";
import { RUNDOWN_PIN_SETTING_KEY } from "@/lib/rundown-pin";

async function assertOrgMembership(orgId: string) {
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

export const validateRundownPin = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, pin: z.string().max(64) }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgMembership(data.orgId);

    const prisma = getPrisma();
    const setting = await prisma.appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY } },
      select: { value: true },
    });

    const ok = await verifyStoredRundownPin(data.pin.trim(), setting?.value);
    if (ok && setting?.value && !isHashedRundownPin(setting.value)) {
      await prisma.appSetting.update({
        where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY } },
        data: { value: await hashRundownPin(data.pin.trim()) },
      });
    }

    return { ok };
  });

export const getRundownPinRequirement = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgMembership(data.orgId);
    const setting = await getPrisma().appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: RUNDOWN_PIN_SETTING_KEY } },
      select: { value: true },
    });
    return { enabled: Boolean(setting?.value.trim()) };
  });

const permissionSchema = z.string().min(1).max(100);

export const checkRoutePermission = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => {
    const parsed = parseOrThrow(
      z.object({
        orgId: idSchema,
        permission: z.union([permissionSchema, z.array(permissionSchema).max(20)]),
      }),
      data,
    );
    // checkPermission rejects unknown permission strings, so the cast is safe.
    return parsed as { orgId: string; permission: Permission | Permission[] };
  })
  .handler(async ({ data }) => {
    const { getAuth } = await import("@/lib/auth");
    const auth = getAuth();
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });

    if (!session) {
      return { ok: false as const, reason: "unauthorized" as const };
    }

    const request = new Request("https://showpilot.local/permission", { headers });
    const result = await checkPermission(
      {
        request,
        env: { DB: env.DB },
        session: { userId: session.user.id, orgId: data.orgId },
      },
      Array.isArray(data.permission) ? data.permission : [data.permission],
    );

    if (!(result instanceof Response)) {
      return { ok: true as const };
    }

    if (result.status === 401) {
      return { ok: false as const, reason: "pin_required" as const };
    }

    // 423 Locked = role has the permission but the org feature flag is off
    // (cloud lower thirds). Surfaced distinctly so the route can explain it.
    if (result.status === 423) {
      return { ok: false as const, reason: "feature_disabled" as const };
    }

    return { ok: false as const, reason: "forbidden" as const };
  });
