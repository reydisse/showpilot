import { hasPermission, type Permission } from "./app-permissions";
import { isGrantablePermission } from "./access-capabilities";
import type { AccessDatabase } from "./effective-access";
const activeSession = `(CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000`;
const notDeleting = `NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=m.organizationId AND key='organization-deleting')`;
export async function memberPermissionGuard(
  database: AccessDatabase,
  orgId: string,
  actor: { userId: string; sessionId: string },
  required: readonly Permission[],
  allowGrants = true,
) {
  const member = await database
    .prepare(
      `SELECT m.id,m.role,m.managementRevision FROM member m JOIN session s ON s.userId=m.userId
    WHERE m.organizationId=? AND m.userId=? AND s.id=? AND ${activeSession} AND ${notDeleting}`,
    )
    .bind(orgId, actor.userId, actor.sessionId)
    .first<{ id: string; role: string; managementRevision: number }>();
  if (!member)
    throw new Error("Your session or required permission is no longer active.");
  const guard = [
    `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=? AND ${activeSession} AND ${notDeleting})`,
  ];
  const guardArgs: (string | number | null)[] = [
    orgId,
    member.id,
    actor.userId,
    member.role,
    member.managementRevision,
    actor.sessionId,
  ];
  const missing = required.filter(
    (permission) => !hasPermission(member.role, permission),
  );
  if (missing.length) {
    if (!allowGrants)
      throw new Error(
        "Your session or required permission is no longer active.",
      );
    const timezone =
      (
        await database
          .prepare(
            "SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'",
          )
          .bind(orgId)
          .first<{ value: string }>()
      )?.value ?? "";
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const now = Date.now(),
      today = formatter.format(new Date(now));
    for (const permission of missing) {
      if (!isGrantablePermission(permission))
        throw new Error(
          "Your session or required permission is no longer active.",
        );
      const grant = `EXISTS(SELECT 1 FROM member_permission_grant g WHERE g.orgId=? AND g.userId=? AND g.revokedAt IS NULL AND g.startsOn<=? AND (g.expiresOn IS NULL OR g.expiresOn>?) AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(g.permissions) AND json_type(g.permissions)='array' THEN g.permissions ELSE '[]' END) p WHERE p.value=?))`;
      const grantArgs = [orgId, actor.userId, today, today, permission];
      if (
        !(await database
          .prepare(`SELECT 1 WHERE ${grant}`)
          .bind(...grantArgs)
          .first())
      )
        throw new Error(
          "Your session or required permission is no longer active.",
        );
      guard.push(grant);
      guardArgs.push(...grantArgs);
    }
    // SQLite cannot evaluate IANA timezones. Bound the reviewed local date at
    // its actual next transition, including shortened/extended DST days.
    let low = now,
      high = now + 48 * 60 * 60 * 1000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (formatter.format(new Date(middle)) === today) low = middle;
      else high = middle;
    }
    guard.push(
      "COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'),'')=?",
      "julianday('now')<julianday(?)",
    );
    guardArgs.push(orgId, timezone, new Date(high).toISOString());
  }
  return { guard: guard.join(" AND "), guardArgs };
}
