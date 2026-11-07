import { markDatabaseWrite } from "./request-database.server";

interface CreationInput {
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: Record<string, unknown>;
  keepCurrentActiveOrganization?: boolean;
}

/** The organization, owner, trial and optional active-session change commit together. */
export async function createOrganizationAtomically(
  db: Pick<D1Database, "prepare" | "batch">,
  actor: { userId: string; sessionId: string },
  input: CreationInput,
) {
  const orgId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const now = Date.now();
  // Match Prisma's ISO dates so mixed writers preserve chronological ordering.
  const createdAt = new Date(now);
  const timestamp = createdAt.toISOString();
  const trialEndsAt = new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString();
  markDatabaseWrite();
  const [inserted] = await db.batch([
    db.prepare(`INSERT INTO organization (id, name, slug, logo, metadata, createdAt, cloud_enabled, trialEndsAt)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?
      WHERE EXISTS (SELECT 1 FROM session s JOIN user u ON u.id = s.userId
        WHERE s.id = ? AND s.userId = ? AND (CASE WHEN typeof(s.expiresAt) IN ('integer', 'real') THEN s.expiresAt
          ELSE (julianday(s.expiresAt) - 2440587.5) * 86400000 END) > ? AND u.emailVerified = 1)`)
      .bind(orgId, input.name, input.slug, input.logo ?? null, input.metadata ? JSON.stringify(input.metadata) : null,
        timestamp, trialEndsAt, actor.sessionId, actor.userId, now),
    db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt)
      SELECT ?, ?, ?, 'owner', ? WHERE EXISTS (SELECT 1 FROM organization WHERE id = ?)`)
      .bind(memberId, orgId, actor.userId, timestamp, orgId),
    ...(!input.keepCurrentActiveOrganization ? [db.prepare(`UPDATE session SET activeOrganizationId = ?, updatedAt = ?
      WHERE id = ? AND userId = ? AND EXISTS (SELECT 1 FROM organization WHERE id = ?)`)
      .bind(orgId, timestamp, actor.sessionId, actor.userId, orgId)] : []),
  ]);
  if (inserted.meta.changes !== 1) return null;
  return {
    id: orgId, name: input.name, slug: input.slug, logo: input.logo ?? null,
    metadata: input.metadata ?? null, createdAt,
    members: [{ id: memberId, organizationId: orgId, userId: actor.userId, role: "owner", createdAt }],
  };
}
