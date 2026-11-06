import { env } from "cloudflare:workers";

/** Real member/session rows, so relay tests exercise live permission checks. */
export async function seedRelayMember(orgId: string, userId = `${orgId}-operator`) {
  const sessionId = `${userId}-session`;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO organization (id,name,slug,createdAt) VALUES (?,?,?,CURRENT_TIMESTAMP)").bind(orgId, orgId, orgId),
    env.DB.prepare("INSERT OR IGNORE INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Relay operator',?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(userId, `${userId}@example.test`),
    env.DB.prepare("INSERT OR IGNORE INTO session (id,expiresAt,token,createdAt,updatedAt,userId,activeOrganizationId) VALUES (?,'2099-01-01T00:00:00.000Z',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?)").bind(sessionId, sessionId, userId, orgId),
    env.DB.prepare("INSERT OR IGNORE INTO member (id,organizationId,userId,role,createdAt) VALUES (?,?,?,'owner',CURRENT_TIMESTAMP)").bind(`${userId}-member`, orgId, userId),
  ]);
  return { userId, sessionId, orgId };
}
