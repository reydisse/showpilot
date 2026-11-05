import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { idSchema, serviceDateSchema, parseOrThrow } from "./validation";
import { requireDisplayAccess } from "./display-access.server";
import { getPrisma } from "./db";
import { getRundownStateForOrg, type PPSlidePayload } from "./rundown";
import { projectRundownDisplayState, type RundownDisplayState as KioskRundownState } from "./rundown-display";

export const getRundownStateBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgSlug: z.string().min(1).max(128), serviceDate: serviceDateSchema, showId: idSchema.optional() }), data))
  .handler(async ({ data }): Promise<{ state: KioskRundownState; message: string; ppSlide: PPSlidePayload | null } | null> => {
    const prisma = getPrisma();

    const org = await prisma.organization.findUnique({
      where: { slug: data.orgSlug },
    });
    if (!org) return null;
    await requireDisplayAccess(env.DB, getRequest(), org.id, "timer", env.KIOSK_SECRET);

    const [state, messageSetting, ppSlideSetting, ppStageDisplaySetting] = await Promise.all([
      getRundownStateForOrg({ orgId: org.id, serviceDate: data.serviceDate, showId: data.showId }),
      prisma.appSetting.findUnique({
        where: {
          orgId_key: { orgId: org.id, key: `rundown-message:${data.showId ?? data.serviceDate}` },
        },
      }),
      prisma.appSetting.findUnique({
        where: {
          orgId_key: { orgId: org.id, key: `rundown-ppslide:${data.showId ?? data.serviceDate}` },
        },
      }),
      prisma.appSetting.findUnique({
        where: {
          orgId_key: { orgId: org.id, key: "propresenter-stage-display" },
        },
      }),
    ]);

    const ppSlideEnabled = ppStageDisplaySetting?.value === "true";
    const ppSlide: PPSlidePayload | null =
      ppSlideEnabled && ppSlideSetting && ppSlideSetting.value !== "null"
        ? JSON.parse(ppSlideSetting.value)
        : null;

    return {
      state: projectRundownDisplayState(state),
      message: messageSetting?.value ?? "",
      ppSlide,
    };
  });

