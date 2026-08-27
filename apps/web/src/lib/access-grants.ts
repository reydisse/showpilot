import { createServerFn } from "@tanstack/react-start";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import {
  ACCESS_CAPABILITY_IDS,
  getAccessCapability,
  type AccessCapabilityId,
} from "@/lib/access-capabilities";
import {
  resolveAccessGrantAuthority,
  resolveEffectiveAccess,
  type AccessDatabase,
} from "@/lib/effective-access";
import { getRequestOrgAccess } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { z } from "zod";

const capabilitySchema = z.enum(ACCESS_CAPABILITY_IDS);
const durationSchema = z.enum(["this-week", "until-revoked"]);
const reasonSchema = z.string().trim().max(240).default("");

export type AccessGrantDuration = "this-week" | "until-revoked";

export interface AccessGrantActor {
  userId: string;
  name: string;
}

interface AccessGrantWriteResult {
  success?: boolean;
  meta?: { changes?: number };
}

interface AccessGrantWriteDatabase extends AccessDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<AccessGrantWriteResult>;
    };
  };
}

function changedOneRow(result: AccessGrantWriteResult): boolean {
  return result.success !== false && result.meta?.changes === 1;
}

export async function getAccessManagementSnapshotForActor(input: {
  orgId: string;
  actorUserId: string;
  database?: AccessDatabase;
}) {
  const authority = await resolveAccessGrantAuthority(
    input.database ?? getD1(),
    input.actorUserId,
    input.orgId,
  );
  if (!authority.canManage) {
    return {
      authority,
      currentUserId: input.actorUserId,
      members: [],
      grants: [],
    };
  }

  const prisma = getPrisma();
  const [members, grants] = await Promise.all([
    prisma.member.findMany({
      where: { organizationId: input.orgId },
      select: {
        userId: true,
        role: true,
        user: { select: { name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.memberPermissionGrant.findMany({
      where: {
        orgId: input.orgId,
        revokedAt: null,
        startsOn: { lte: authority.today },
        OR: [{ expiresOn: null }, { expiresOn: { gt: authority.today } }],
      },
      select: {
        id: true,
        userId: true,
        capability: true,
        permissions: true,
        startsOn: true,
        expiresOn: true,
        reason: true,
        grantedByUserId: true,
        createdAt: true,
        grantedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    authority,
    currentUserId: input.actorUserId,
    members,
    grants: grants.map((grant) => ({
      ...grant,
      canRevoke:
        authority.kind === "permanent" ||
        (grant.startsOn >= authority.weekStart &&
          grant.expiresOn === authority.weekEndExclusive),
    })),
  };
}

async function createGrantNotification(
  orgId: string,
  userId: string,
  title: string,
  message: string,
  actionUrl: string,
) {
  try {
    await getPrisma().notification.create({
      data: {
        orgId,
        userId,
        type: "access-grant",
        severity: "info",
        title,
        message,
        target: "personal",
        source: "access-control",
        actionUrl,
      },
    });
  } catch {
    // The access mutation is authoritative. A notification failure must not
    // leave the grant half-created or prevent an urgent revocation.
  }
}

export const getEffectiveAccessSnapshot = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    const request = await getRequestOrgAccess(data.orgId);
    const access = await resolveEffectiveAccess(getD1(), request.user.id, data.orgId);
    if (!access) throw new Error("Forbidden");
    const authority = await resolveAccessGrantAuthority(
      getD1(),
      request.user.id,
      data.orgId,
      access.today,
    );
    return {
      role: access.role,
      grantedPermissions: access.grantedPermissions,
      permissions: access.permissions,
      revision: `${access.role}:${authority.kind}:${authority.weekStart}:${access.revision}:${access.permissions.join(",")}`,
    };
  });

export const getAccessManagementSnapshot = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    const { user } = await getRequestOrgAccess(data.orgId);
    return getAccessManagementSnapshotForActor({
      orgId: data.orgId,
      actorUserId: user.id,
    });
  });

export async function grantMemberAccessForActor(input: {
  orgId: string;
  actor: AccessGrantActor;
  userId: string;
  capability: AccessCapabilityId;
  duration: AccessGrantDuration;
  reason: string;
  database?: AccessGrantWriteDatabase;
}) {
  const database = input.database ?? getD1();
  const authority = await resolveAccessGrantAuthority(
    database,
    input.actor.userId,
    input.orgId,
  );
  if (!authority.canManage) throw new Error("Only an Owner, Admin, or the on-duty TM can grant access.");
  if (input.userId === input.actor.userId) throw new Error("Access grants must be assigned to another member.");
  if (authority.kind === "on-duty-tm" && input.duration !== "this-week") {
    throw new Error("The on-duty TM can grant access only for the current duty week.");
  }

  const capability = getAccessCapability(input.capability);
  if (!capability) throw new Error("Unknown capability.");

  const prisma = getPrisma();
  const target = await prisma.member.findFirst({
    where: { organizationId: input.orgId, userId: input.userId },
    select: { user: { select: { name: true } } },
  });
  if (!target) throw new Error("That person is not a member of this organization.");

  const startsOn = input.duration === "this-week" ? authority.weekStart : authority.today;
  const expiresOn = input.duration === "this-week" ? authority.weekEndExclusive : null;
  const grantId = crypto.randomUUID();
  const insert = await database.prepare(
    `INSERT INTO member_permission_grant
       (id, orgId, userId, capability, permissions, startsOn, expiresOn, reason,
        grantedByUserId, createdAt, updatedAt)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     WHERE NOT EXISTS (
       SELECT 1 FROM member_permission_grant
       WHERE orgId = ? AND userId = ? AND capability = ? AND revokedAt IS NULL
         AND startsOn <= ? AND (expiresOn IS NULL OR expiresOn > ?)
     )`,
  ).bind(
    grantId,
    input.orgId,
    input.userId,
    input.capability,
    JSON.stringify(capability.permissions),
    startsOn,
    expiresOn,
    input.reason,
    input.actor.userId,
    input.orgId,
    input.userId,
    input.capability,
    authority.today,
    authority.today,
  ).run();
  if (!changedOneRow(insert)) {
    throw new Error(`${target.user.name} already has ${capability.label} access.`);
  }

  const durationLabel = expiresOn ? "for the current duty week" : "until it is revoked";
  await createGrantNotification(
    input.orgId,
    input.userId,
    "Access granted",
    `${input.actor.name} granted you ${capability.label} access ${durationLabel}.`,
    capability.notificationPath,
  );
  return { id: grantId };
}

export const grantMemberAccess = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        orgId: idSchema,
        userId: idSchema,
        capability: capabilitySchema,
        duration: durationSchema,
        reason: reasonSchema,
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const { user } = await getRequestOrgAccess(data.orgId);
    return grantMemberAccessForActor({
      orgId: data.orgId,
      actor: { userId: user.id, name: user.name },
      userId: data.userId,
      capability: data.capability,
      duration: data.duration,
      reason: data.reason,
    });
  });

export async function revokeMemberAccessForActor(input: {
  orgId: string;
  actor: AccessGrantActor;
  grantId: string;
  database?: AccessGrantWriteDatabase;
}) {
  const database = input.database ?? getD1();
  const authority = await resolveAccessGrantAuthority(
    database,
    input.actor.userId,
    input.orgId,
  );
  if (!authority.canManage) throw new Error("Only an Owner, Admin, or the on-duty TM can revoke access.");

  const prisma = getPrisma();
  const grant = await prisma.memberPermissionGrant.findFirst({
    where: { id: input.grantId, orgId: input.orgId, revokedAt: null },
    select: {
      id: true,
      userId: true,
      capability: true,
      startsOn: true,
      expiresOn: true,
    },
  });
  if (!grant) throw new Error("This access grant is no longer active.");

  const tmMayRevoke =
    grant.startsOn >= authority.weekStart && grant.expiresOn === authority.weekEndExclusive;
  if (authority.kind === "on-duty-tm" && !tmMayRevoke) {
    throw new Error("The on-duty TM can revoke only grants for the current duty week.");
  }

  const update = await database.prepare(
    `UPDATE member_permission_grant
     SET revokedAt = CURRENT_TIMESTAMP, revokedByUserId = ?, updatedAt = CURRENT_TIMESTAMP
     WHERE id = ? AND orgId = ? AND revokedAt IS NULL`,
  ).bind(input.actor.userId, grant.id, input.orgId).run();
  if (!changedOneRow(update)) throw new Error("This access grant is no longer active.");

  const capability = getAccessCapability(grant.capability);
  await createGrantNotification(
    input.orgId,
    grant.userId,
    "Access revoked",
    `${input.actor.name} revoked your ${capability?.label ?? "custom"} access.`,
    "",
  );
  return { ok: true as const };
}

export const revokeMemberAccess = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, grantId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const { user } = await getRequestOrgAccess(data.orgId);
    return revokeMemberAccessForActor({
      orgId: data.orgId,
      actor: { userId: user.id, name: user.name },
      grantId: data.grantId,
    });
  });
