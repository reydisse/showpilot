import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow, serviceDateSchema } from "@/lib/validation";

import { getActiveRundownRelayTarget } from "@/lib/active-rundown-relay";
import { env } from "cloudflare:workers";

const showTargetSchema = z.object({ showId: idSchema.nullable(), serviceDate: serviceDateSchema });

const actionSchema = z.enum([
  "lower-third-clear",
]);
export type TmControlAction = z.infer<typeof actionSchema>;
export interface TmControlState {
  target: z.infer<typeof showTargetSchema>;
  timer: { playback: string; elapsed: number };
  currentItem: { id: string; title: string } | null;
  nextItem: { title: string } | null;
  lyricsEnabled: boolean;
  kioskBlanked: boolean;
  stream: { connected: number; total: number };
}

async function assertControlAccess(orgId: string, action?: TmControlAction) {
  const { user, access } = await assertOrgPermission(orgId, "dashboard:tm");
  if (
    action === "lower-third-clear" &&
    !hasEffectivePermission(access.role, access.grantedPermissions, "lowerthird:trigger")
  ) throw new Error("Forbidden");
  return { userId: user.id, userName: user.name || "Technical operator" };
}

export const getTmControlState = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertControlAccess(data.orgId);
    const [{ buildCompanionDeps }, { getState }] = await Promise.all([
      import("@/lib/companion-api"), import("@/lib/companion-control"),
    ]);
    const target = await getActiveRundownRelayTarget(env.DB, data.orgId);
    const result = await getState(buildCompanionDeps({ orgId: data.orgId, target }), data.orgId);
    const body = result.body;
    return {
      target: { showId: target.showId, serviceDate: target.serviceDate },
      timer: { playback: String(body.timer?.playback ?? "stop"), elapsed: Number(body.timer?.elapsed ?? 0) },
      currentItem: body.currentItem ? { id: String(body.currentItem.id ?? ""), title: String(body.currentItem.title ?? "") } : null,
      nextItem: body.nextItem ? { title: String(body.nextItem.title ?? "") } : null,
      lyricsEnabled: Boolean(body.lyricsEnabled),
      kioskBlanked: Boolean(body.kioskBlanked),
      stream: { connected: Number(body.stream?.connected ?? 0), total: Number(body.stream?.total ?? 0) },
    } satisfies TmControlState;
  });

export const runTmControl = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, action: actionSchema }), data))
  .handler(async ({ data }) => {
    await assertControlAccess(data.orgId, data.action);
    const [api, control] = await Promise.all([import("@/lib/companion-api"), import("@/lib/companion-control")]);
    const target = await getActiveRundownRelayTarget(env.DB, data.orgId);
    const deps = api.buildCompanionDeps({ orgId: data.orgId, target });
    const handlers: Record<TmControlAction, () => Promise<{ status: number; body: Record<string, unknown> }>> = {
      "lower-third-clear": () => control.clearLowerThird(deps, data.orgId),
    };
    const result = await handlers[data.action]();
    if (result.status >= 400) throw new Error(String(result.body.error ?? "Control failed"));
    return { ok: true as const, action: data.action, showId: target.showId, serviceDate: target.serviceDate };
  });
