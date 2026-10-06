import { resolveEffectiveAccess, type AccessDatabase } from "./effective-access";

interface ChatRecipientDatabase extends AccessDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
}

export async function groupChatNotificationRecipients(
  db: ChatRecipientDatabase,
  orgId: string,
  senderId: string,
  roomId: string,
): Promise<string[]> {
  if (roomId !== "production" && roomId !== "planning") return [];
  const members = await db.prepare("SELECT userId FROM member WHERE organizationId = ?")
    .bind(orgId).all<{ userId: string }>();
  const recipients: string[] = [];
  for (const member of members.results ?? []) {
    if (member.userId === senderId) continue;
    const access = await resolveEffectiveAccess(db, member.userId, orgId);
    if (access?.permissions.includes("chat:access")) recipients.push(member.userId);
  }
  return recipients;
}
