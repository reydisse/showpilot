import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getPrisma } from "@/lib/db";
import { z } from "zod";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { chatHistoryClearSchema } from "./chat-history-clear-contract";
import { clearOrganizationChat } from "./chat-history-clear.server";
import { assertOrgPermission } from "@/lib/org-access";

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
  .inputValidator((data: unknown) => parseOrThrow(chatHistoryClearSchema, data))
  .handler(async ({ data }) => {
    const { getAuth } = await import("./auth");
    const session = await getAuth().api.getSession({ headers: getRequestHeaders(), query: { disableCookieCache: true } });
    if (!session) throw new Error("Sign in before clearing chat history.");
    return clearOrganizationChat({command:data,authority:{orgId:data.orgId,userId:session.user.id,sessionId:session.session.id}});
  });
