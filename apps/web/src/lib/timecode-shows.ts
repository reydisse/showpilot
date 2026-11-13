import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { assertOrgPermission as assertEffectiveOrgPermission } from "./org-access";
import { idSchema, parseOrThrow } from "./validation";
import { resolveTimecodeTarget } from "./timecode-target.server";
import { listTimecodeShows } from "./timecode-shows.server";

export const getTimecodeShows = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertEffectiveOrgPermission(data.orgId, "timecode:access");
    const [result, active] = await Promise.all([
      listTimecodeShows(env.DB, data.orgId),
      resolveTimecodeTarget(env.DB, data.orgId),
    ]);
    return { shows: result, activeShowId: active?.showId ?? null };
  });
