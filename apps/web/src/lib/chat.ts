import { createServerFn } from "@tanstack/react-start";
import { getPrisma } from "@/lib/db";

export const getChatMessages = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string; limit?: number }) => data)
  .handler(async ({ data }) => {
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
    const prisma = getPrisma();
    return await prisma.chatMessage.create({
      data: {
        orgId: data.orgId,
        message: data.message.trim(),
        senderName: data.senderName.trim(),
      },
    });
  });
