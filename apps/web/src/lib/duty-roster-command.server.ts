import { getD1 } from "./d1";
import { hasPermission } from "./app-permissions";
import {
  DEFAULT_DUTY_ROLES,
  dutyRosterResultSchema,
  dutyRosterCommandSchema,
  type DutyRosterCommand,
} from "./duty-roster-contract";
import {
  readDutyRoster,
  dutySlotWrites,
  removalJobs,
  type DutyDatabase,
  type DutySlot,
} from "./duty-roster-storage.server";
import {
  flushDutyNotifications,
  pendingDutyNotifications,
} from "./duty-notification-jobs.server";
import { withOperationTimeout } from "./operation-timeout";
export type DutyActor = { userId: string; sessionId: string };
const activeSession = `(CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000`;
const notDeleting = `NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=m.organizationId AND key='organization-deleting')`;
async function authority(
  database: DutyDatabase,
  orgId: string,
  actor: DutyActor,
) {
  const member = await database
    .prepare(
      `SELECT m.id,m.role,m.managementRevision FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.userId=? AND s.id=? AND ${activeSession} AND ${notDeleting}`,
    )
    .bind(orgId, actor.userId, actor.sessionId)
    .first<{ id: string; role: string; managementRevision: number }>();
  if (!member || !hasPermission(member.role, "settings:members"))
    throw new Error(
      "Your session or permission to manage duty assignments is no longer active.",
    );
  return member;
}
async function deliver(database: DutyDatabase, orgId: string) {
  try {
    await withOperationTimeout(
      flushDutyNotifications(database, orgId),
      5_000,
      "Duty notification delivery is still pending",
    );
  } catch (error) {
    console.error("[Duty roster] Notifications remain queued", error);
  }
  return pendingDutyNotifications(database, orgId);
}
export async function readMemberDutyRoster(
  orgId: string,
  weekStart: string,
  actor: DutyActor,
) {
  await authority(getD1(), orgId, actor);
  return readDutyRoster(getD1(), orgId, weekStart);
}
export async function retryDutyNotificationDelivery(
  orgId: string,
  actor: DutyActor,
) {
  await authority(getD1(), orgId, actor);
  return { pendingNotifications: await deliver(getD1(), orgId) };
}
export async function executeDutyRosterCommand(
  input: DutyRosterCommand,
  actor: DutyActor,
  database: DutyDatabase = getD1(),
) {
  const command = dutyRosterCommandSchema.parse(input);
  const member = await authority(database, command.orgId, actor);
  const guard = `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=? AND ${activeSession} AND ${notDeleting})`;
  const guardArgs = [
      command.orgId,
      member.id,
      actor.userId,
      member.role,
      member.managementRevision,
      actor.sessionId,
    ],
    scope = [command.orgId, actor.userId, command.requestId],
    fingerprint = JSON.stringify(command),
    claimId = crypto.randomUUID();
  const readReceipt = () =>
    database
      .prepare(
        `SELECT fingerprint,outcome FROM duty_roster_command_receipt WHERE orgId=? AND actorId=? AND requestId=? AND ${guard}`,
      )
      .bind(...scope, ...guardArgs)
      .first<{ fingerprint: string; outcome: string }>();
  const result = async (receipt: { fingerprint: string; outcome: string }) => {
    if (receipt.fingerprint !== fingerprint)
      throw new Error(
        "This request already belongs to a different duty roster command.",
      );
    if (receipt.outcome === "applied") await deliver(database, command.orgId);
    return dutyRosterResultSchema.parse({
      requestId: command.requestId,
      outcome: receipt.outcome,
      snapshot: await readDutyRoster(
        database,
        command.orgId,
        command.weekStart,
      ),
    });
  };
  const previous = await readReceipt();
  if (previous) return await result(previous);
  const snapshot = await readDutyRoster(
    database,
    command.orgId,
    command.weekStart,
  );
  const versionArgs: unknown[] = [command.orgId, command.rolesRevision];
  let reviewed =
    "COALESCE((SELECT revision FROM duty_roster_version WHERE orgId=? AND scope='roles'),0)=?";
  const slots: DutySlot[] = [];
  if (command.action === "save-week" || command.action === "set-officer") {
    reviewed +=
      " AND COALESCE((SELECT revision FROM duty_roster_version WHERE orgId=? AND scope=?),0)=?";
    versionArgs.push(
      command.orgId,
      `week:${command.weekStart}`,
      command.weekRevision,
    );
    if (command.action === "save-week") {
      const requested = new Map(command.tech.map((s) => [s.roleId, s.userId]));
      if (
        command.tech.some((s) => !snapshot.roles.some((r) => r.id === s.roleId))
      )
        reviewed += " AND 0";
      slots.push(
        {
          kind: "pm",
          roleId: null,
          roleName: "Production Manager",
          userId: command.pmUserId,
        },
        ...snapshot.roles.map((role) => ({
          kind: "tech" as const,
          roleId: role.id,
          roleName: role.name,
          userId: requested.get(role.id) ?? null,
        })),
      );
    } else if (command.duty === "pm")
      slots.push({
        kind: "pm",
        roleId: null,
        roleName: "Production Manager",
        userId: command.userId,
      });
    else {
      const role = snapshot.roles.find(
        (role) => role.code.toLowerCase() === "tm",
      );
      if (!role)
        throw new Error(
          "Add a Technical Manager (tm) role in Settings before assigning that duty.",
        );
      slots.push({
        kind: "tech",
        roleId: role.id,
        roleName: role.name,
        userId: command.userId,
      });
    }
  }
  if (command.action === "delete-role") {
    reviewed +=
      " AND EXISTS(SELECT 1 FROM roster_role WHERE orgId=? AND id=? AND revision=?)";
    versionArgs.push(command.orgId, command.roleId, command.roleRevision);
  }
  if (command.action === "seed-roles") {
    reviewed += " AND NOT EXISTS(SELECT 1 FROM roster_role WHERE orgId=?)";
    versionArgs.push(command.orgId);
  }
  const people = slots.flatMap((s) => (s.userId ? [s.userId] : []));
  const validPeople =
    "NOT EXISTS(SELECT 1 FROM json_each(?) person WHERE NOT EXISTS(SELECT 1 FROM member WHERE organizationId=? AND userId=person.value))";
  const peopleArgs = [JSON.stringify(people), command.orgId];
  const codeAvailable =
    command.action === "create-role"
      ? "NOT EXISTS(SELECT 1 FROM roster_role WHERE orgId=? AND code=?)"
      : "1";
  const codeArgs =
    command.action === "create-role" ? [command.orgId, command.code] : [];
  const owns =
      "EXISTS(SELECT 1 FROM duty_roster_command_receipt WHERE orgId=? AND actorId=? AND requestId=? AND claimId=? AND outcome='applied')",
    ownsArgs = [...scope, claimId];
  const statements = [
    database
      .prepare(
        `INSERT INTO duty_roster_command_receipt(orgId,actorId,requestId,fingerprint,claimId,outcome)
  SELECT ?,?,?,?,?,CASE WHEN NOT(${reviewed}) THEN 'conflict' WHEN NOT(${validPeople}) THEN 'member-unavailable' WHEN NOT(${codeAvailable}) THEN 'role-code-taken' ELSE 'applied' END WHERE ${guard} ON CONFLICT(orgId,actorId,requestId) DO NOTHING`,
      )
      .bind(
        ...scope,
        fingerprint,
        claimId,
        ...versionArgs,
        ...peopleArgs,
        ...codeArgs,
        ...guardArgs,
      ),
  ];
  if (command.action === "seed-roles" || command.action === "create-role") {
    const roles =
      command.action === "seed-roles" ? DEFAULT_DUTY_ROLES : [command];
    for (const role of roles)
      statements.push(
        database
          .prepare(
            `INSERT INTO roster_role(id,orgId,code,name,short,sortOrder) SELECT ?,?,?,?,?,(SELECT COALESCE(MAX(sortOrder),0)+1 FROM roster_role WHERE orgId=?) WHERE ${owns}`,
          )
          .bind(
            crypto.randomUUID(),
            command.orgId,
            role.code,
            role.name,
            role.short,
            command.orgId,
            ...ownsArgs,
          ),
      );
  } else if (command.action === "delete-role") {
    statements.push(
      removalJobs(
        database,
        "a.orgId=? AND a.roleId=?",
        [command.orgId, command.roleId],
        owns,
        ownsArgs,
      ),
      database
        .prepare(
          `DELETE FROM roster_assignment WHERE orgId=? AND roleId=? AND ${owns}`,
        )
        .bind(command.orgId, command.roleId, ...ownsArgs),
      database
        .prepare(`DELETE FROM roster_role WHERE orgId=? AND id=? AND ${owns}`)
        .bind(command.orgId, command.roleId, ...ownsArgs),
    );
  } else
    for (const slot of slots)
      statements.push(
        ...dutySlotWrites(
          database,
          command.orgId,
          command.weekStart,
          slot,
          owns,
          ownsArgs,
        ),
      );
  const scopeKey =
    command.action === "save-week" || command.action === "set-officer"
      ? `week:${command.weekStart}`
      : "roles";
  statements.push(
    database
      .prepare(
        `INSERT INTO duty_roster_version(orgId,scope,revision) SELECT ?,?,1 WHERE ${owns} ON CONFLICT(orgId,scope) DO UPDATE SET revision=revision+1`,
      )
      .bind(command.orgId, scopeKey, ...ownsArgs),
  );
  await database.batch(statements);
  const receipt = await readReceipt();
  if (!receipt)
    throw new Error(
      "Your access changed before this roster command was confirmed. Review access and retry.",
    );
  return await result(receipt);
}
