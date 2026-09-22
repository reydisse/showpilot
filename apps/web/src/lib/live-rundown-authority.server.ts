import { accessHasAnyPermission, resolveEffectiveAccess } from "./effective-access";
import { permissionsRequireRundownPin, RUNDOWN_PIN_SETTING_KEY } from "./rundown-pin.server";
import { verifyStoredRundownPin } from "./rundown-pin-crypto";
import type { Permission } from "./permissions";

interface AuthorityDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

export interface LiveSessionAuthorityClaim {
  userId: string;
  sessionId: string;
  orgId: string;
}

export interface LiveRundownAuthorityClaim extends LiveSessionAuthorityClaim {
  rundownPin: string | null;
}

interface SessionRow {
  expiresAt: string | number | Date;
}

function sessionIsCurrent(row: SessionRow | null, now: number): boolean {
  if (!row) return false;
  const expiry = row.expiresAt instanceof Date
    ? row.expiresAt.getTime()
    : typeof row.expiresAt === "number"
      ? row.expiresAt
      : Date.parse(row.expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

export async function hasLiveRundownAuthority(
  db: AuthorityDatabase,
  claim: LiveRundownAuthorityClaim,
  required: Permission | readonly Permission[],
  now = Date.now(),
): Promise<boolean> {
  const access = await getLiveSessionAccess(db, claim, now);
  const permissions = Array.isArray(required) ? required : [required];
  if (!access || !accessHasAnyPermission(access, permissions)) return false;
  if (!permissionsRequireRundownPin(access.role, permissions)) return true;

  const setting = await db.prepare(
    "SELECT value FROM app_setting WHERE orgId = ? AND key = ? LIMIT 1",
  ).bind(claim.orgId, RUNDOWN_PIN_SETTING_KEY).first<{ value: string | null }>();
  return verifyStoredRundownPin(claim.rundownPin, setting?.value);
}

async function getLiveSessionAccess(
  db: AuthorityDatabase,
  claim: LiveSessionAuthorityClaim,
  now: number,
) {
  const session = await db.prepare(
    "SELECT expiresAt FROM session WHERE id = ? AND userId = ? LIMIT 1",
  ).bind(claim.sessionId, claim.userId).first<SessionRow>();
  if (!sessionIsCurrent(session, now)) return null;
  return resolveEffectiveAccess(db, claim.userId, claim.orgId);
}

export async function hasLivePermissionAuthority(
  db: AuthorityDatabase,
  claim: LiveSessionAuthorityClaim,
  required: Permission | readonly Permission[],
  now = Date.now(),
): Promise<boolean> {
  const access = await getLiveSessionAccess(db, claim, now);
  const permissions = Array.isArray(required) ? required : [required];
  return Boolean(access && accessHasAnyPermission(access, permissions));
}
