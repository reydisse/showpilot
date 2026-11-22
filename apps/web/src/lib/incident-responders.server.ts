import { hasPermission, type Permission } from "./permissions";

/** Minimal statement surface shared by D1 and the mobile API's database wrapper. */
export interface IncidentResponderDatabase {
  prepare(sql: string): { bind(...params: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
}

export type IncidentResponder = { userId: string; name: string; role: string };

function parsePermissionSnapshot(value: string): Permission[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Permission =>
        typeof item === "string" && item === "incidents:access",
    );
  } catch {
    return [];
  }
}

/**
 * Members who can own an incident: their role grants `incidents:access`, or an
 * active per-member grant does. Web and mobile assignment both use this rule.
 */
export async function resolveIncidentResponders(
  orgId: string,
  today: string,
  db: IncidentResponderDatabase,
): Promise<IncidentResponder[]> {
  const [membersResult, grantsResult] = await Promise.all([
    db
      .prepare(
        `SELECT m.userId, m.role, u.name
       FROM member m JOIN user u ON u.id = m.userId
       WHERE m.organizationId = ? ORDER BY u.name ASC, m.userId ASC`,
      )
      .bind(orgId)
      .all<IncidentResponder>(),
    db
      .prepare(
        `SELECT userId, permissions FROM member_permission_grant
       WHERE orgId = ? AND revokedAt IS NULL AND startsOn <= ?
         AND (expiresOn IS NULL OR expiresOn > ?)`,
      )
      .bind(orgId, today, today)
      .all<{ userId: string; permissions: string }>(),
  ]);
  const grantedUsers = new Set(
    (grantsResult.results ?? [])
      .filter((grant) =>
        parsePermissionSnapshot(grant.permissions).includes("incidents:access"),
      )
      .map((grant) => grant.userId),
  );
  return (membersResult.results ?? [])
    .filter(
      (member) =>
        hasPermission(member.role, "incidents:access") ||
        grantedUsers.has(member.userId),
    )
    .map((member) => ({ userId: member.userId, name: member.name, role: member.role }));
}
