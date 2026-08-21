import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { hasEffectivePermission } from "@/lib/app-permissions";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";

const actionSchema = z.enum([
  "timer-start", "timer-stop", "timer-add", "timer-subtract",
  "rundown-next", "rundown-previous", "lyrics-on", "lyrics-off",
  "lower-third-clear", "displays-blank", "displays-restore",
  "stream-live", "stream-stop",
]);
export type TmControlAction = z.infer<typeof actionSchema>;
export interface TmControlState {
  timer: { playback: string; elapsed: number };
  currentItem: { title: string } | null;
  nextItem: { title: string } | null;
  lyricsEnabled: boolean;
  kioskBlanked: boolean;
  stream: { connected: number; total: number };
}

async function assertControlAccess(orgId: string, action?: TmControlAction) {
  const { user, access } = await assertOrgPermission(orgId, "dashboard:tm");
  if (
    (action === "stream-live" || action === "stream-stop") &&
    !hasEffectivePermission(access.role, access.grantedPermissions, "stream_health:manage")
  ) throw new Error("Forbidden");
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
    const result = await getState(buildCompanionDeps(), data.orgId);
    if (result.status !== 200) throw new Error(String(result.body.error ?? "Controls unavailable"));
    const body = result.body as Record<string, any>;
    return {
      timer: { playback: String(body.timer?.playback ?? "stop"), elapsed: Number(body.timer?.elapsed ?? 0) },
      currentItem: body.currentItem ? { title: String(body.currentItem.title ?? "") } : null,
      nextItem: body.nextItem ? { title: String(body.nextItem.title ?? "") } : null,
      lyricsEnabled: Boolean(body.lyricsEnabled),
      kioskBlanked: Boolean(body.kioskBlanked),
      stream: { connected: Number(body.stream?.connected ?? 0), total: Number(body.stream?.total ?? 0) },
    } satisfies TmControlState;
  });

export const runTmControl = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema, action: actionSchema }), data))
  .handler(async ({ data }) => {
    const viewer = await assertControlAccess(data.orgId, data.action);
    const [api, control] = await Promise.all([import("@/lib/companion-api"), import("@/lib/companion-control")]);
    const deps = api.buildCompanionDeps();
    const handlers: Record<TmControlAction, () => Promise<{ status: number; body: Record<string, unknown> }>> = {
      "timer-start": () => control.timerStart(deps, data.orgId),
      "timer-stop": () => control.timerStop(deps, data.orgId),
      "timer-add": () => control.timerAdd(deps, data.orgId, 60),
      "timer-subtract": () => control.timerSubtract(deps, data.orgId, 60),
      "rundown-next": () => control.rundownNext(deps, data.orgId),
      "rundown-previous": () => control.rundownPrevious(deps, data.orgId),
      "lyrics-on": () => control.setLyrics(deps, data.orgId, true),
      "lyrics-off": () => control.setLyrics(deps, data.orgId, false),
      "lower-third-clear": () => control.clearLowerThird(deps, data.orgId),
      "displays-blank": () => control.kioskBlank(deps, data.orgId, true),
      "displays-restore": () => control.kioskBlank(deps, data.orgId, false),
      "stream-live": () => control.streamGoLive(deps, data.orgId),
      "stream-stop": () => control.streamStop(deps, data.orgId),
    };
    const result = await handlers[data.action]();
    if (result.status >= 400) throw new Error(String(result.body.error ?? "Control failed"));
    if (["stream-live", "stream-stop", "displays-blank"].includes(data.action)) {
      try {
        await getPrisma().notification.create({ data: {
          orgId: data.orgId, type: "technical-control", severity: "info",
          title: `Technical control: ${data.action}`,
          message: `${viewer.userName} ran ${data.action} from the Tech Manager dashboard.`,
          target: "tech-manager", source: viewer.userId,
        } });
      } catch { /* The control succeeded; audit delivery recovers independently. */ }
    }
    return { ok: true as const, action: data.action };
  });
