import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import {
  resolveAccessGrantAuthority,
  resolveEffectiveAccess,
} from "@/lib/effective-access";
import { getRequestOrgAccess } from "@/lib/org-access";
import { idSchema, parseOrThrow } from "@/lib/validation";
import { z } from "zod";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  grantAccessSchema,
  revokeAccessSchema,
  accessWriteSchema,
} from "./access-write-contract";
import {
  writeAccessGrant,
  readAccessActor,
  pendingAccessNotices,
  retryAccessNotice,
  type AccessWriteDatabase,
  type AccessGrantActor,
} from "./access-write.server";

export type AccessGrantDuration = "this-week" | "until-revoked";
export type { AccessGrantActor } from "./access-write.server";

export const getAccessManagementSnapshotForActor = createServerOnlyFn(
  async (input: {
    orgId: string;
    actorUserId: string;
    database?: AccessWriteDatabase;
  }) => {
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
        notices: [],
      };
    }

    const prisma = getPrisma();
    const [members, grants, notices] = await Promise.all([
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
      pendingAccessNotices(
        input.database ?? getD1(),
        input.orgId,
        input.actorUserId,
      ),
    ]);

    return {
      authority,
      currentUserId: input.actorUserId,
      members,
      notices,
      grants: grants.map((grant) => ({
        ...grant,
        canRevoke:
          authority.kind === "permanent" ||
          (grant.startsOn >= authority.weekStart &&
            grant.expiresOn === authority.weekEndExclusive),
      })),
    };
  },
);

export const getEffectiveAccessSnapshot = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const request = await getRequestOrgAccess(data.orgId);
    const access = await resolveEffectiveAccess(
      getD1(),
      request.user.id,
      data.orgId,
    );
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
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema }), data),
  )
  .handler(async ({ data }) => {
    const { user } = await getRequestOrgAccess(data.orgId);
    return getAccessManagementSnapshotForActor({
      orgId: data.orgId,
      actorUserId: user.id,
    });
  });

export const grantMemberAccessForActor = createServerOnlyFn(
  async (
    input: z.input<typeof grantAccessSchema> & {
      actor: AccessGrantActor;
      database?: AccessWriteDatabase;
    },
  ) =>
    writeAccessGrant(
      input.database ?? getD1(),
      input.actor,
      accessWriteSchema.parse({ ...input, kind: "grant" }),
    ),
);

export const grantMemberAccess = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(grantAccessSchema, data))
  .handler(async ({ data }) =>
    grantMemberAccessForActor({
      ...data,
      actor: await readAccessActor(getRequestHeaders()),
    }),
  );

export const revokeMemberAccessForActor = createServerOnlyFn(
  async (
    input: z.input<typeof revokeAccessSchema> & {
      actor: AccessGrantActor;
      database?: AccessWriteDatabase;
    },
  ) =>
    writeAccessGrant(
      input.database ?? getD1(),
      input.actor,
      accessWriteSchema.parse({ ...input, kind: "revoke" }),
    ),
);

export const revokeMemberAccess = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(revokeAccessSchema, data))
  .handler(async ({ data }) =>
    revokeMemberAccessForActor({
      ...data,
      actor: await readAccessActor(getRequestHeaders()),
    }),
  );

export const retryAccessGrantNotification = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, requestId: z.uuid() }), data),
  )
  .handler(async ({ data }) =>
    retryAccessNotice(
      getD1(),
      await readAccessActor(getRequestHeaders()),
      data,
    ),
  );
