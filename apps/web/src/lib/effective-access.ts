import {
  getEffectivePermissions,
  hasAnyEffectivePermission,
  normalizeRole,
  type Permission,
  type Role,
} from "@/lib/permissions";
import { isGrantablePermission } from "@/lib/access-capabilities";
import { getTodayDateString } from "@/lib/utils";

interface D1BoundStatement {
  first<T>(): Promise<T | null>;
}

interface D1Statement {
  bind(...params: unknown[]): D1BoundStatement;
}

export interface AccessDatabase {
  prepare(sql: string): D1Statement;
}

interface MemberRoleRow {
  role: string;
}

interface SettingRow {
  value: string;
}

interface GrantPermissionAggregate {
  grantSets: string | null;
  revision: string | null;
}

export interface EffectiveAccess {
  role: Role;
  grantedPermissions: Permission[];
  permissions: Permission[];
  revision: string;
  today: string;
}

export interface AccessGrantAuthority {
  canManage: boolean;
  kind: "permanent" | "on-duty-tm" | "none";
  weekStart: string;
  weekEndExclusive: string;
  today: string;
}

export function weekStartForAccess(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return date;
  value.setUTCDate(value.getUTCDate() - value.getUTCDay());
  return value.toISOString().slice(0, 10);
}

export function addAccessDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(value.getTime())) return date;
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function parseGrantedPermissions(serialized: string): Permission[] {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(isGrantablePermission))];
  } catch {
    return [];
  }
}

async function resolveOrgToday(
  db: AccessDatabase,
  orgId: string,
  todayOverride?: string,
): Promise<string> {
  if (todayOverride) return todayOverride;
  const setting = await db
    .prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'org-timezone' LIMIT 1")
    .bind(orgId)
    .first<SettingRow>();
  return getTodayDateString(setting?.value || undefined);
}

export async function resolveEffectiveAccess(
  db: AccessDatabase,
  userId: string,
  orgId: string,
  todayOverride?: string,
): Promise<EffectiveAccess | null> {
  const member = await db
    .prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ? LIMIT 1")
    .bind(userId, orgId)
    .first<MemberRoleRow>();
  const role = normalizeRole(member?.role ?? null);
  if (!role) return null;

  const today = await resolveOrgToday(db, orgId, todayOverride);
  let aggregate: GrantPermissionAggregate | null = null;
  try {
    aggregate = await db
      .prepare(
        `SELECT json_group_array(permissions) AS grantSets,
                MAX(updatedAt) AS revision
           FROM member_permission_grant
          WHERE orgId = ?
            AND userId = ?
            AND revokedAt IS NULL
            AND startsOn <= ?
            AND (expiresOn IS NULL OR expiresOn > ?)
          ORDER BY createdAt`,
      )
      .bind(orgId, userId, today, today)
      .first<GrantPermissionAggregate>();
  } catch {
    // Existing local databases may briefly predate migration 0029. Falling
    // back to the base role preserves current access without granting more.
    aggregate = null;
  }

  let serializedGrantSets: string[] = [];
  try {
    const parsed: unknown = JSON.parse(aggregate?.grantSets ?? "[]");
    if (Array.isArray(parsed)) {
      serializedGrantSets = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    serializedGrantSets = [];
  }
  const grantedPermissions = [
    ...new Set(serializedGrantSets.flatMap(parseGrantedPermissions)),
  ];
  const revision = aggregate?.revision ?? "";

  return {
    role,
    grantedPermissions,
    permissions: getEffectivePermissions(role, grantedPermissions),
    revision,
    today,
  };
}

export async function resolveAccessGrantAuthority(
  db: AccessDatabase,
  userId: string,
  orgId: string,
  todayOverride?: string,
): Promise<AccessGrantAuthority> {
  const access = await resolveEffectiveAccess(db, userId, orgId, todayOverride);
  const today = access?.today ?? (await resolveOrgToday(db, orgId, todayOverride));
  const weekStart = weekStartForAccess(today);
  const weekEndExclusive = addAccessDays(weekStart, 7);

  if (access?.role === "owner" || access?.role === "admin") {
    return { canManage: true, kind: "permanent", weekStart, weekEndExclusive, today };
  }
  if (!access) {
    return { canManage: false, kind: "none", weekStart, weekEndExclusive, today };
  }

  let onDuty: { id: string } | null = null;
  try {
    onDuty = await db
      .prepare(
        `SELECT a.id
           FROM roster_assignment a
           JOIN roster_role r ON r.id = a.roleId AND r.orgId = a.orgId
          WHERE a.orgId = ?
            AND a.weekStart = ?
            AND a.kind = 'tech'
            AND lower(r.code) = 'tm'
            AND a.userId = ?
          LIMIT 1`,
      )
      .bind(orgId, weekStart, userId)
      .first<{ id: string }>();
  } catch {
    onDuty = null;
  }

  return {
    canManage: Boolean(onDuty),
    kind: onDuty ? "on-duty-tm" : "none",
    weekStart,
    weekEndExclusive,
    today,
  };
}

export function accessHasAnyPermission(
  access: EffectiveAccess | null,
  required: readonly Permission[],
): boolean {
  return Boolean(
    access && hasAnyEffectivePermission(access.role, access.grantedPermissions, required),
  );
}
