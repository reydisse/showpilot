import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import { getAuth } from "@/lib/auth";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { hasAnyPermission } from "@/lib/app-permissions";
import { idSchema, parseOrThrow } from "@/lib/validation";

export const REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "🙏"] as const;
const reactionEmoji = z.enum(REACTION_EMOJIS);
const targetType = z.enum(["incident-comment", "chat-message"]);

export interface ContentReaction {
  id: string;
  targetType: "incident-comment" | "chat-message";
  targetId: string;
  userId: string;
  authorName: string;
  emoji: (typeof REACTION_EMOJIS)[number];
  createdAt: string;
}

async function assertAccess(orgId: string) {
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
  if (!session) throw new Error("Unauthorized");
  const member = await getPrisma().member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  if (!member || !hasAnyPermission(member.role ?? "member", ["chat:access", "incidents:report", "incidents:access"])) throw new Error("Forbidden");
  return session.user;
}

export const getContentReactions = createServerFn({ method: "GET" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, targetType, targetIds: z.array(idSchema).max(200) }), value))
  .handler(async ({ data }): Promise<ContentReaction[]> => {
    await assertAccess(data.orgId);
    if (data.targetIds.length === 0) return [];
    const placeholders = data.targetIds.map(() => "?").join(",");
    const rows = await getD1().prepare(
      `SELECT id, targetType, targetId, userId, authorName, emoji, createdAt
       FROM content_reaction WHERE orgId = ? AND targetType = ? AND targetId IN (${placeholders})
       ORDER BY createdAt ASC`,
    ).bind(data.orgId, data.targetType, ...data.targetIds).all<ContentReaction>();
    return rows.results ?? [];
  });

export const toggleContentReaction = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => parseOrThrow(z.object({ orgId: idSchema, targetType, targetId: idSchema, emoji: reactionEmoji }), value))
  .handler(async ({ data }) => {
    const user = await assertAccess(data.orgId);
    const existing = await getD1().prepare(
      "SELECT id FROM content_reaction WHERE orgId = ? AND targetType = ? AND targetId = ? AND userId = ? AND emoji = ?",
    ).bind(data.orgId, data.targetType, data.targetId, user.id, data.emoji).first<{ id: string }>();
    if (existing) {
      await getD1().prepare("DELETE FROM content_reaction WHERE id = ? AND orgId = ? AND userId = ?").bind(existing.id, data.orgId, user.id).run();
      return { active: false as const };
    }

    let targetAuthorId: string | null = null;
    let incidentId: string | null = null;
    if (data.targetType === "incident-comment") {
      const target = await getD1().prepare("SELECT userId, incidentId FROM incident_comment WHERE id = ? AND orgId = ?").bind(data.targetId, data.orgId).first<{ userId: string; incidentId: string }>();
      if (!target) throw new Error("Comment not found");
      targetAuthorId = target.userId;
      incidentId = target.incidentId;
    }
    const reaction: ContentReaction = { id: crypto.randomUUID(), targetType: data.targetType, targetId: data.targetId, userId: user.id, authorName: user.name, emoji: data.emoji, createdAt: new Date().toISOString() };
    await getD1().prepare("INSERT INTO content_reaction (id, orgId, targetType, targetId, userId, authorName, emoji, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(reaction.id, data.orgId, reaction.targetType, reaction.targetId, reaction.userId, reaction.authorName, reaction.emoji, reaction.createdAt).run();

    if (targetAuthorId && targetAuthorId !== user.id && incidentId) {
      const { notifyOperationalEvent } = await import("@/lib/operational-notifications.server");
      await notifyOperationalEvent({
        orgId: data.orgId,
        actorId: user.id,
        recipientIds: [targetAuthorId],
        type: "comment-reaction",
        title: `${user.name} reacted ${data.emoji} to your comment`,
        message: "Open the incident discussion to view the reaction.",
        actionUrl: `production/incidents?incident=${encodeURIComponent(incidentId)}`,
        source: data.targetId,
        pushTag: `comment-reaction-${data.targetId}`,
      });
    }
    return { active: true as const, reaction };
  });
