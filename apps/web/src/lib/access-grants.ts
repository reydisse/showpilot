import { createServerFn } from "@tanstack/react-start";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import {
  ACCESS_CAPABILITY_IDS,
  getAccessCapability,
} from "@/lib/access-capabilities";
import {
  resolveAccessGrantAuthority,
  resolveEffectiveAccess,
} from "@/lib/effective-access";
import { getRequestOrgAccess } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { z } from "zod";

const capabilitySchema = z.enum(ACCESS_CAPABILITY_IDS);
const durationSchema = z.enum(["this-week", "until-revoked"]);
const reasonSchema = z.string().trim().max(240).default("");

async function getAuthority(orgId: string) {
  const request = await getRequestOrgAccess(orgId);
  const authority = await resolveAccessGrantAuthority(getD1(), request.user.id, orgId);
  return { ...request, authority };
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
    const { user, authority } = await getAuthority(data.orgId);
    if (!authority.canManage) {
      return {
        authority,
        currentUserId: user.id,
        members: [],
        grants: [],
      };
    }

    const prisma = getPrisma();
    const [members, grants] = await Promise.all([
      prisma.member.findMany({
        where: { organizationId: data.orgId },
        select: {
          userId: true,
          role: true,
          user: { select: { name: true, email: true, image: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.memberPermissionGrant.findMany({
        where: {
          orgId: data.orgId,
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
      currentUserId: user.id,
      members,
      grants: grants.map((grant) => ({
        ...grant,
        canRevoke:
          authority.kind === "permanent" ||
          (grant.startsOn >= authority.weekStart &&
            grant.expiresOn === authority.weekEndExclusive),
      })),
    };
  });

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
    const { user, authority } = await getAuthority(data.orgId);
    if (!authority.canManage) throw new Error("Only an Owner, Admin, or the on-duty TM can grant access.");
    if (data.userId === user.id) throw new Error("Access grants must be assigned to another member.");
    if (authority.kind === "on-duty-tm" && data.duration !== "this-week") {
      throw new Error("The on-duty TM can grant access only for the current duty week.");
    }

    const capability = getAccessCapability(data.capability);
    if (!capability) throw new Error("Unknown capability.");

    const prisma = getPrisma();
    const target = await prisma.member.findFirst({
      where: { organizationId: data.orgId, userId: data.userId },
      select: { user: { select: { name: true } } },
    });
    if (!target) throw new Error("That person is not a member of this organization.");

    const startsOn = data.duration === "this-week" ? authority.weekStart : authority.today;
    const expiresOn = data.duration === "this-week" ? authority.weekEndExclusive : null;
    const duplicate = await prisma.memberPermissionGrant.findFirst({
      where: {
        orgId: data.orgId,
        userId: data.userId,
        capability: data.capability,
        revokedAt: null,
        startsOn: { lte: authority.today },
        OR: [{ expiresOn: null }, { expiresOn: { gt: authority.today } }],
      },
      select: { id: true },
    });
    if (duplicate) throw new Error(`${target.user.name} already has ${capability.label} access.`);

    const grant = await prisma.memberPermissionGrant.create({
      data: {
        orgId: data.orgId,
        userId: data.userId,
        capability: data.capability,
        permissions: JSON.stringify(capability.permissions),
        startsOn,
        expiresOn,
        reason: data.reason,
        grantedByUserId: user.id,
      },
      select: { id: true },
    });

    const durationLabel = expiresOn ? "for the current duty week" : "until it is revoked";
    await createGrantNotification(
      data.orgId,
      data.userId,
      "Access granted",
      `${user.name} granted you ${capability.label} access ${durationLabel}.`,
      capability.notificationPath,
    );
    return grant;
  });

export const revokeMemberAccess = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, grantId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const { user, authority } = await getAuthority(data.orgId);
    if (!authority.canManage) throw new Error("Only an Owner, Admin, or the on-duty TM can revoke access.");

    const prisma = getPrisma();
    const grant = await prisma.memberPermissionGrant.findFirst({
      where: { id: data.grantId, orgId: data.orgId, revokedAt: null },
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

    await prisma.memberPermissionGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedByUserId: user.id },
    });

    const capability = getAccessCapability(grant.capability);
    await createGrantNotification(
      data.orgId,
      grant.userId,
      "Access revoked",
      `${user.name} revoked your ${capability?.label ?? "custom"} access.`,
      "",
    );
    return { ok: true as const };
  });
