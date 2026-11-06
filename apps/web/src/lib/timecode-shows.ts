import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission as assertEffectiveOrgPermission } from "./org-access";
import { idSchema, parseOrThrow } from "./validation";
import { resolveTimecodeTarget } from "./timecode-target.server";
import type { TimecodeShow } from "@/types/timecode";

export const getTimecodeShows = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertEffectiveOrgPermission(data.orgId, "timecode:access");
    const [result, active] = await Promise.all([
      env.DB.prepare(`SELECT r.id, r.serviceDate, r.name, r.scheduledStartTime FROM rundown r
        WHERE r.orgId = ? AND NOT EXISTS (SELECT 1 FROM app_setting s WHERE s.orgId=r.orgId AND s.key='show-deleting:'||r.id)
        ORDER BY r.serviceDate ASC, r.scheduledStartTime ASC, r.createdAt ASC`).bind(data.orgId).all<TimecodeShow>(),
      resolveTimecodeTarget(env.DB, data.orgId),
    ]);
    return { shows: result.results, activeShowId: active?.showId ?? null };
  });
