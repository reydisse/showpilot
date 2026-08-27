import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { hasPermission } from "@/lib/app-permissions";
import { assertOrgPermission } from "@/lib/org-access";

async function assertChatAdmin(orgId: string) {
  const { getAuth } = await import("@/lib/auth");
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  if (!member || !hasPermission(member.role, "settings:organization")) {
    throw new Error("Forbidden");
  }
}

export const getChatMessages = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; limit?: number }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "chat:access");
    const prisma = getPrisma();
    return await prisma.chatMessage.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "desc" },
      take: data.limit ?? 50,
    });
  });

export const sendChatMessage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, message: z.string().min(1).max(4000) }), data),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "chat:access");
    const { getAuth } = await import("@/lib/auth");
    const auth = getAuth();
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });
    if (!session) throw new Error("Unauthorized");

    const prisma = getPrisma();
    const member = await prisma.member.findFirst({
      where: { organizationId: data.orgId, userId: session.user.id },
      select: { id: true, role: true },
    });
    if (!member) throw new Error("Forbidden");

    return await prisma.chatMessage.create({
      data: {
        orgId: data.orgId,
        message: data.message.trim(),
        senderName: session.user.name,
        senderRole: member.role ?? undefined,
      },
    });
  });

export const clearChatHistory = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertChatAdmin(data.orgId);
    const prisma = getPrisma();
    await prisma.chatMessage.deleteMany({ where: { orgId: data.orgId } });
  });
