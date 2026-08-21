import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import { assertOrgPermission } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";

const roomIdSchema = z.string().min(1).max(220);
const mentionPattern = /<@([^|>]+)\|([^>]+)>/g;

async function assertChatMember(orgId: string) {
  const { user } = await assertOrgPermission(orgId, "chat:access");
  return user;
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
    messageId: idSchema.optional(),
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
    const chatNotifications = await getPrisma().appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "notify-app-chat" } },
      select: { value: true },
    });
    // Existing organizations have no setting row yet; keep notifications on
    // until the owner explicitly turns them off.
    if (chatNotifications?.value === "false") return { notified: 0 };

    const validMembers = await getPrisma().member.findMany({
      where: { organizationId: data.orgId, userId: { in: [...recipients.keys()] } },
      select: { userId: true },
    });
    const cleanText = data.text.replace(mentionPattern, "@$2").trim().slice(0, 240) || "Shared an attachment";
    const actionUrl = `chat?room=${encodeURIComponent(data.roomId)}${data.messageId ? `&message=${encodeURIComponent(data.messageId)}` : ""}`;
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
        url: `/${encodeURIComponent(data.orgSlug)}/${actionUrl}`,
        tag: kind === "dm" ? `chat-dm-${data.roomId}` : `chat-mention-${data.roomId}`,
      });
    }));
    return { notified: validMembers.length };
  });

export const notifyChatReaction = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({
    orgId: idSchema,
    roomId: roomIdSchema,
    messageId: idSchema,
    targetUserId: idSchema,
    emoji: z.enum(["👍", "❤️", "🎉", "👀", "🙏"]),
  }), data))
  .handler(async ({ data }) => {
    const sender = await assertChatMember(data.orgId);
    if (sender.id === data.targetUserId) return { notified: 0 };
    const chatNotifications = await getPrisma().appSetting.findUnique({
      where: { orgId_key: { orgId: data.orgId, key: "notify-app-chat" } },
      select: { value: true },
    });
    if (chatNotifications?.value === "false") return { notified: 0 };
    const target = await getPrisma().member.findFirst({
      where: { organizationId: data.orgId, userId: data.targetUserId },
      select: { userId: true },
    });
    if (!target) return { notified: 0 };
    const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
    await notifyOperationalEvent({
      orgId: data.orgId,
      actorId: sender.id,
      recipientIds: [target.userId],
      type: "chat-reaction",
      title: `${sender.name} reacted ${data.emoji} to your message`,
      message: "Open the conversation to view the reaction.",
      actionUrl: `chat?room=${encodeURIComponent(data.roomId)}&message=${encodeURIComponent(data.messageId)}`,
      source: data.messageId,
      pushTag: `chat-reaction-${data.messageId}`,
    });
    return { notified: 1 };
  });
