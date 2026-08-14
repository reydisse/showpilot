import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { hasPermission } from "@/lib/permissions";
import { idSchema, parseOrThrow } from "@/lib/validation";

const roomIdSchema = z.string().min(1).max(220);
const mentionPattern = /<@([^|>]+)\|([^>]+)>/g;

async function assertChatMember(orgId: string) {
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  if (!member || !hasPermission(member.role, "chat:access")) throw new Error("Forbidden");
  return session.user;
}

export interface ChatMemberSummary {
  userId: string;
  name: string;
  role: string;
  image: string | null;
}

export const getChatMembers = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }): Promise<ChatMemberSummary[]> => {
    await assertChatMember(data.orgId);
    const members = await getPrisma().member.findMany({
      where: { organizationId: data.orgId },
      select: { userId: true, role: true, user: { select: { name: true, image: true } } },
      orderBy: { createdAt: "asc" },
    });
    return members.map((member) => ({
      userId: member.userId,
      name: member.user.name,
      role: member.role,
      image: member.user.image,
    }));
  });

export const notifyChatMessage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    orgSlug: z.string().min(1).max(100),
    roomId: roomIdSchema,
    text: z.string().max(4000),
    mentionedUserIds: z.array(idSchema).max(20).optional(),
  }), data))
  .handler(async ({ data }) => {
    const sender = await assertChatMember(data.orgId);
    const recipients = new Map<string, "dm" | "mention">();
    const dmParts = data.roomId.split(":");
    if (dmParts.length === 3 && dmParts[0] === "dm" && dmParts.slice(1).includes(sender.id)) {
      const recipientId = dmParts.slice(1).find((id) => id !== sender.id);
      if (recipientId) recipients.set(recipientId, "dm");
    }
    for (const userId of data.mentionedUserIds ?? []) if (userId !== sender.id) recipients.set(userId, "mention");
    if (recipients.size === 0) return { notified: 0 };

    const validMembers = await getPrisma().member.findMany({
      where: { organizationId: data.orgId, userId: { in: [...recipients.keys()] } },
      select: { userId: true },
    });
    const cleanText = data.text.replace(mentionPattern, "@$2").trim().slice(0, 240) || "Shared an attachment";
    const actionUrl = `chat?room=${encodeURIComponent(data.roomId)}`;
    await Promise.all(validMembers.map(async ({ userId }) => {
      const kind = recipients.get(userId) ?? "mention";
      const title = kind === "dm" ? `New message from ${sender.name}` : `${sender.name} mentioned you`;
      await getD1().prepare(
        `INSERT INTO notification
         (id, orgId, userId, type, severity, title, message, target, source, actionUrl, dismissed, createdAt)
         VALUES (?, ?, ?, ?, 'info', ?, ?, ?, 'chat', ?, 0, CURRENT_TIMESTAMP)`,
      ).bind(
        crypto.randomUUID(), data.orgId, userId,
        kind === "dm" ? "chat-direct-message" : "chat-mention",
        title,
        cleanText, `user:${userId}`, actionUrl,
      ).run();
      const { deliverPushToUser } = await import("@/lib/push-delivery.server");
      await deliverPushToUser(data.orgId, userId, {
        title,
        body: cleanText,
        url: `/${encodeURIComponent(data.orgSlug)}/chat?room=${encodeURIComponent(data.roomId)}`,
        tag: kind === "dm" ? `chat-dm-${data.roomId}` : `chat-mention-${data.roomId}`,
      });
    }));
    return { notified: validMembers.length };
  });
