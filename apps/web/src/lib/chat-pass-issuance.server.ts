import { z } from "zod";
import { crewChatClaimsSchema, planningChatClaimsSchema, CREW_CHAT_PREFIX, PLANNING_CHAT_PREFIX } from "./chat-pass-token";
import { chatPassCommandSchema, type ChatPassCommand, type ChatPassNotification, type CreatedChatPass } from "./chat-pass-creation";
import { chatTokenIsRevoked, type ChatPassDatabase } from "./chat-pass-revocation.server";
import { signToken } from "./kiosk-token";
import { scopedTokenDigest } from "./scoped-token-store.server";
import { resolveEffectiveAccess } from "./effective-access";
import { withOperationTimeout } from "./operation-timeout";

export class ChatPassCreationError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) { super(message); }
}
export function chatPassCreationMessage(error: unknown): string {
  return error instanceof ChatPassCreationError ? error.message : "Could not confirm the link. Retry with the same choices.";
}

export const CHAT_PASS_CREATORS = new Set(["owner", "admin", "td", "pd", "pm", "sm", "tm"]);
const savedFields = { iat: z.number().int().nonnegative(), nonce: z.string().uuid() };
const savedClaims = z.discriminatedUnion("scope", [crewChatClaimsSchema.extend(savedFields), planningChatClaimsSchema.extend(savedFields)]);

/** Shared by web and mobile. The adapter supplies a freshly authenticated actor. */
export async function issueChatPass(db: ChatPassDatabase, secret: string, actor: { userId: string; name: string }, input: ChatPassCommand): Promise<CreatedChatPass> {
  const command = chatPassCommandSchema.parse(input);
  const access = await resolveEffectiveAccess(db, actor.userId, command.orgId);
  if (!access || !CHAT_PASS_CREATORS.has(access.role) || !access.permissions.includes("chat:access")) throw new ChatPassCreationError("Only production leaders with chat access can create links", 403);
  const org = await db.prepare("SELECT slug FROM organization WHERE id = ? LIMIT 1").bind(command.orgId).first<{ slug: string }>();
  if (!org) throw new ChatPassCreationError("Workspace not found", 404);
  const targets = command.scope === "planning-chat" ? [...new Set(command.targetUserIds)].sort() : [];
  if (targets.length) {
    const members = await db.prepare(`SELECT userId FROM member WHERE organizationId = ? AND userId IN (${targets.map(() => "?").join(",")})`)
      .bind(command.orgId, ...targets).all<{ userId: string }>();
    if (new Set(members.results?.map(member => member.userId)).size !== targets.length) throw new ChatPassCreationError("Every selected person must still be a workspace member", 400);
  }
  const requestId = command.requestId ?? crypto.randomUUID();
  const fingerprint = await scopedTokenDigest(JSON.stringify({ scope: command.scope, hours: command.hours, targets }));
  const read = () => db.prepare("SELECT fingerprint,payload FROM chat_pass_creation_receipt WHERE orgId=? AND actorId=? AND requestId=?")
    .bind(command.orgId, actor.userId, requestId).first<{ fingerprint: string; payload: string }>();
  let receipt = await read();
  if (!receipt) {
    const now = Math.floor(Date.now()/1000);
    const common = { orgId: command.orgId, orgSlug: org.slug, iat: now, exp: now+command.hours*3600, nonce: crypto.randomUUID() };
    const payload = savedClaims.parse(command.scope === "crew-chat" ? { ...common, scope: command.scope }
      : { ...common, scope: command.scope, roomId: "planning", targetUserIds: targets });
    await db.prepare(`INSERT INTO chat_pass_creation_receipt (orgId,actorId,requestId,fingerprint,payload,createdAt)
      VALUES (?,?,?,?,?,?) ON CONFLICT(orgId,actorId,requestId) DO NOTHING`)
      .bind(command.orgId, actor.userId, requestId, fingerprint, JSON.stringify(payload), Date.now()).run();
    receipt = await read();
  }
  if (!receipt) throw new ChatPassCreationError("The link result is unconfirmed. Retry with the same choices.", 409);
  if (receipt.fingerprint !== fingerprint) throw new ChatPassCreationError("These choices differ from the saved request. Start a new link to change them.", 409);
  const payload = savedClaims.parse(JSON.parse(receipt.payload));
  if (payload.orgId !== command.orgId || payload.scope !== command.scope) throw new ChatPassCreationError("The saved link could not be recovered. Start a new link.", 409);
  if (payload.exp*1000 <= Date.now()) throw new ChatPassCreationError("This saved link has expired. Start a new link.", 409);
  const token = `${payload.scope === "crew-chat" ? CREW_CHAT_PREFIX : PLANNING_CHAT_PREFIX}${await signToken(payload, secret)}`;
  if (await chatTokenIsRevoked(db, command.orgId, token)) throw new ChatPassCreationError("This saved link was revoked. Start a new link.", 409);
  let notifications: ChatPassNotification = { status: "not-needed" };
  if (payload.scope === "planning-chat") {
    const recipients = payload.targetUserIds.filter(id => id !== actor.userId);
    if (recipients.length) {
      const source = `planning-chat:${payload.nonce}`;
      try {
        const { notifyOperationalEvent } = await import("./operational-notifications.server");
        await withOperationTimeout(notifyOperationalEvent({
          orgId: command.orgId, actorId: actor.userId, recipientIds: recipients, category: "chat", type: "chat-planning-invite",
          title: `${actor.name} shared the Planning Room with you`, message: "Open Planning Room to join your team.", actionUrl: "chat?room=planning",
          source, dedupeKey: source, once: true, pushTag: `planning-chat-invite-${command.orgId}`,
        }), 5_000, "Notification confirmation timed out");
        const saved = await db.prepare(`SELECT COUNT(DISTINCT userId) AS count FROM notification WHERE orgId=? AND source=? AND type='chat-planning-invite' AND userId IN (${recipients.map(() => "?").join(",")})`)
          .bind(command.orgId, source, ...recipients).first<{ count: number }>();
        const missing = Math.max(0, recipients.length-(saved?.count ?? 0));
        notifications = missing ? { status: "pending", missing } : { status: "saved", recipients: recipients.length };
      } catch { notifications = { status: "pending", missing: recipients.length }; }
    }
  }
  return { token, orgSlug: payload.orgSlug, expiresAt: payload.exp*1000, targetCount: targets.length, notifications };
}
