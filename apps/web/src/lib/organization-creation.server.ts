import { z } from "zod";
import { markDatabaseWrite } from "./request-database.server";
import type { OrganizationCreationSnapshot } from "./organization-creation-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
interface CreationInput {
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: Record<string, unknown>;
  keepCurrentActiveOrganization?: boolean;
}
interface CreationValue {
  id: string; name: string; slug: string; logo: string | null;
  metadata: Record<string, unknown> | null; createdAt: Date; creationRequestId?: string;
  members: { id: string; organizationId: string; userId: string; role: "owner"; createdAt: Date }[];
}
export class OrganizationCreationReceiptError extends Error {
  constructor(readonly code: "mismatch" | "removed" | "forbidden") {
    super(code === "mismatch" ? "This creation request already belongs to different choices. Check its saved result."
      : code === "removed" ? "The workspace created by this request was removed. It will not be recreated."
      : "You can no longer manage the workspace created by this request.");
  }
}
type Receipt = { fingerprint: string } & ({ status: "saved"; value: CreationValue } | { status: "removed" | "forbidden" });
async function readReceipt(db: Database, userId: string, requestId: string): Promise<Receipt | null> {
  const receipt = await db.prepare("SELECT orgId, fingerprint FROM organization_creation_receipt WHERE userId = ? AND requestId = ?")
    .bind(userId, requestId).first<{ orgId: string; fingerprint: string }>();
  if (!receipt) return null;
  const row = await db.prepare(`SELECT o.id,o.name,o.slug,o.logo,o.metadata,o.createdAt,
    m.id AS memberId,m.role,m.createdAt AS memberCreatedAt FROM organization o
    LEFT JOIN member m ON m.organizationId = o.id AND m.userId = ? WHERE o.id = ?`)
    .bind(userId, receipt.orgId).first<{ id: string; name: string; slug: string; logo: string | null; metadata: string | null; createdAt: string | number;
      memberId: string | null; role: string | null; memberCreatedAt: string | number | null }>();
  if (!row) return { fingerprint: receipt.fingerprint, status: "removed" };
  if (row.role !== "owner" || !row.memberId || row.memberCreatedAt === null) return { fingerprint: receipt.fingerprint, status: "forbidden" };
  return { fingerprint: receipt.fingerprint, status: "saved", value: {
    id: row.id, name: row.name, slug: row.slug, logo: row.logo,
    metadata: row.metadata === null ? null : z.record(z.string(), z.unknown()).parse(JSON.parse(row.metadata)),
    createdAt: new Date(row.createdAt), creationRequestId: requestId,
    members: [{ id: row.memberId, organizationId: row.id, userId, role: "owner", createdAt: new Date(row.memberCreatedAt) }],
  } };
}
export async function readOrganizationCreation(db: Database, userId: string, requestId: string): Promise<OrganizationCreationSnapshot> {
  const receipt = await readReceipt(db, userId, requestId);
  if (!receipt) return { requestId, status: "empty" };
  if (receipt.status !== "saved") return { requestId, status: receipt.status };
  const { id, name, slug } = receipt.value;
  return { requestId, status: "saved", organization: { id, name, slug } };
}
function savedValue(receipt: Receipt | null, fingerprint: string): CreationValue | null {
  if (!receipt) return null;
  if (receipt.fingerprint !== fingerprint) throw new OrganizationCreationReceiptError("mismatch");
  if (receipt.status !== "saved") throw new OrganizationCreationReceiptError(receipt.status);
  return receipt.value;
}
async function fingerprint(input: CreationInput, setup: boolean) {
  const normalized = { name: input.name, slug: input.slug, logo: input.logo ?? null, metadata: input.metadata ?? null,
    keepCurrentActiveOrganization: Boolean(input.keepCurrentActiveOrganization), setup };
  const json = JSON.stringify(normalized, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

/** Creation and its receipt commit together; a replay reads without restoring any rows. */
export async function createOrganizationAtomically(
  db: Database,
  actor: { userId: string; sessionId: string },
  input: CreationInput,
  intent: { requestId?: string; setup?: boolean } = {},
): Promise<CreationValue | null> {
  const requestId = intent.requestId;
  const hash = requestId ? await fingerprint(input, Boolean(intent.setup)) : "";
  if (requestId) {
    const saved = savedValue(await readReceipt(db, actor.userId, requestId), hash);
    if (saved) return saved;
  }
  const orgId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const now = Date.now();
  // Match Prisma's ISO dates so mixed writers preserve chronological ordering.
  const createdAt = new Date(now);
  const timestamp = createdAt.toISOString();
  const trialEndsAt = new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString();
  const authority = `EXISTS (SELECT 1 FROM session s JOIN user u ON u.id = s.userId
    WHERE s.id = ? AND s.userId = ? AND (CASE WHEN typeof(s.expiresAt) IN ('integer', 'real') THEN s.expiresAt
      ELSE (julianday(s.expiresAt) - 2440587.5) * 86400000 END) > ? AND u.emailVerified = 1)`;
  const ownerOfAttempt = requestId ? `EXISTS (SELECT 1 FROM organization_creation_receipt WHERE userId = ? AND requestId = ? AND orgId = ?)` : authority;
  markDatabaseWrite();
  const results = await db.batch([
    ...(requestId ? [db.prepare(`INSERT INTO organization_creation_receipt (userId,requestId,orgId,fingerprint,createdAt)
      SELECT ?,?,?,?,? WHERE ${authority} ON CONFLICT(userId,requestId) DO NOTHING`)
      .bind(actor.userId, requestId, orgId, hash, timestamp, actor.sessionId, actor.userId, now)] : []),
    db.prepare(`INSERT INTO organization (id, name, slug, logo, metadata, createdAt, cloud_enabled, trialEndsAt)
      SELECT ?, ?, ?, ?, ?, ?, 1, ? WHERE ${ownerOfAttempt}`)
      .bind(orgId, input.name, input.slug, input.logo ?? null, input.metadata ? JSON.stringify(input.metadata) : null,
        timestamp, trialEndsAt, ...(requestId ? [actor.userId, requestId, orgId] : [actor.sessionId, actor.userId, now])),
    db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt)
      SELECT ?, ?, ?, 'owner', ? WHERE EXISTS (SELECT 1 FROM organization WHERE id = ?)`)
      .bind(memberId, orgId, actor.userId, timestamp, orgId),
    ...(intent.setup ? [db.prepare(`INSERT INTO app_setting (id,orgId,key,value) SELECT ?,?,'onboarding-started',?
      WHERE EXISTS (SELECT 1 FROM organization WHERE id = ?)`)
      .bind(crypto.randomUUID(), orgId, timestamp, orgId)] : []),
    ...(!input.keepCurrentActiveOrganization ? [db.prepare(`UPDATE session SET activeOrganizationId = ?, updatedAt = ?
      WHERE id = ? AND userId = ? AND EXISTS (SELECT 1 FROM organization WHERE id = ?)`)
      .bind(orgId, timestamp, actor.sessionId, actor.userId, orgId)] : []),
  ]);
  if (requestId) return savedValue(await readReceipt(db, actor.userId, requestId), hash);
  if (results[0].meta.changes !== 1) return null;
  return {
    id: orgId, name: input.name, slug: input.slug, logo: input.logo ?? null,
    metadata: input.metadata ?? null, createdAt,
    members: [{ id: memberId, organizationId: orgId, userId: actor.userId, role: "owner", createdAt }],
  };
}
