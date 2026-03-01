import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";

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
    return await prisma.streamDestination.update({
      where: { id: data.id },
      data: { enabled: data.enabled },
    });
  });
