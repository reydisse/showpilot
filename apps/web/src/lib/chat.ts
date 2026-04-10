import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";

async function assertOrgAccess(orgId: string) {
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

export const getChatMessages = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; limit?: number }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.chatMessage.findMany({
      where: { orgId: data.orgId },
      orderBy: { createdAt: "desc" },
      take: data.limit ?? 50,
    });
  });

export const sendChatMessage = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string; message: string; senderName: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    return await prisma.chatMessage.create({
      data: {
        orgId: data.orgId,
        message: data.message.trim(),
        senderName: data.senderName.trim(),
      },
    });
  });

export const clearChatHistory = createServerFn({ method: "POST" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgAccess(data.orgId);
    const prisma = getPrisma();
    await prisma.chatMessage.deleteMany({ where: { orgId: data.orgId } });
  });
