import { assertTeamCommandSuccess } from "./team-command.server";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders, setResponseHeader } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { getD1 } from "@/lib/d1";
import {
  resolveAccessGrantAuthority,
  resolveEffectiveAccess,
} from "@/lib/effective-access";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { resolveMemberRoleForOrg } from "@/lib/org-role";
import { z } from "zod";
import { emailSchema, idSchema, parseOrThrow } from "@/lib/validation";
import { withPrimaryDatabase } from "./request-database.server";

// Role names are org-defined (dynamic access control) — bound, not enumerated.
const roleNameSchema = z.string().min(1).max(50);
const teamRetryFields = { requestId: z.uuid().optional(), expectedRevision: z.number().int().nonnegative().optional() };
function teamRequestHeaders(data: { requestId?: string; expectedRevision?: number }) {
  const headers = new Headers(getRequestHeaders());
  if (data.requestId) headers.set("Idempotency-Key", data.requestId);
  if (data.expectedRevision !== undefined) headers.set("X-ShowPilot-Member-Revision", String(data.expectedRevision));
  return headers;
}
const organizationMemberRow = z.object({
  id: z.string(), organizationId: z.string(), userId: z.string(), role: z.string(),
  managementRevision: z.number().int().nonnegative(), createdAt: z.union([z.number(), z.string()]),
  userName: z.string(), userEmail: z.string(), userImage: z.string().nullable(),
});

async function getSessionOrThrow() {
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");
  return session;
}

async function assertOrgMembership(userId: string, orgId: string) {
  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId },
    select: { id: true },
  });
  if (!member) throw new Error("Forbidden");
}

async function getOrgMemberRole(orgId: string) {
  const session = await getSessionOrThrow();

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role) throw new Error("Forbidden");
  return role;
}

async function assertOrgPermission(orgId: string, permission: Parameters<typeof hasPermission>[1]) {
  const role = await getOrgMemberRole(orgId);
  if (!hasPermission(role, permission)) throw new Error("Forbidden");
}

// ─── Request Info ────────────────────────────────────────

export const getRequestHost = createServerFn({ method: "GET" }).handler(
  async () => {
    const headers = getRequestHeaders();
    return headers.get("host") || "";
  }
);

// ─── Session ─────────────────────────────────────────────

export const getSession = createServerFn({ method: "GET" }).handler(
  async () => {
    return await getSessionOrThrow().catch(() => null);
  }
);

/**
 * One request for the organization route shell. Keeping session, membership,
 * and organization lookup together removes a full client/server waterfall
 * from every in-app navigation.
 */
export const getOrgRouteContext = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.string().min(1).max(100), data))
  .handler(async ({ data }) => {
    const session = await getSessionOrThrow().catch(() => null);
    if (!session) return null;
    const membership = await getPrisma().member.findFirst({
      where: { userId: session.user.id, organization: { slug: data } },
      select: {
        role: true,
        organization: true,
      },
    });
    const memberRole = normalizeRole(membership?.role ?? null);
    if (!membership || !memberRole) return null;
    const effectiveAccess = await resolveEffectiveAccess(
      getD1(),
      session.user.id,
      membership.organization.id,
    );
    if (!effectiveAccess) return null;
    const accessAuthority = await resolveAccessGrantAuthority(
      getD1(),
      session.user.id,
      membership.organization.id,
      effectiveAccess.today,
    );
    return {
      user: session.user,
      activeOrganizationId: session.session.activeOrganizationId,
      org: membership.organization,
      memberRole,
      grantedPermissions: effectiveAccess.grantedPermissions,
      effectivePermissions: effectiveAccess.permissions,
      accessRevision: `${memberRole}:${accessAuthority.kind}:${accessAuthority.weekStart}:${effectiveAccess.revision}:${effectiveAccess.permissions.join(",")}`,
      accessAuthority,
    };
  });

export const getSessionWithOrg = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await getSessionOrThrow().catch(() => null);
    if (!session) return null;

    const orgId = session.session.activeOrganizationId;
    if (!orgId) return { ...session, org: null };

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
    });
    return { ...session, org };
  }
);

// ─── Organization ────────────────────────────────────────

export const getOrgBySlug = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    const session = await getSessionOrThrow().catch(() => null);
    if (!session) return null;

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { slug: data },
    });

    if (!org) return null;

    // Role is resolved for THIS org (the one in the URL) — never from
    // session.activeOrganizationId. Lookup errors propagate.
    const memberRole = await resolveMemberRoleForOrg(prisma, org.id, session.user.id);

    return memberRole ? { ...org, memberRole } : null;
  });

export const setActiveOrg = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(idSchema, data))
  .handler(async ({ data }) => {
    const session = await getSessionOrThrow();
    await assertOrgMembership(session.user.id, data);

    const auth = getAuth();
    const headers = getRequestHeaders();
    try {
      await auth.api.setActiveOrganization({
        headers,
        body: { organizationId: data },
      });
      return;
    } catch {
      const prisma = getPrisma();
      await prisma.session.updateMany({
        where: { id: session.session.id, userId: session.user.id },
        data: { activeOrganizationId: data },
      });
    }
  });

export const listUserOrgs = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await getSessionOrThrow().catch(() => null);
    if (!session) return [];

    const prisma = getPrisma();
    const memberships = await prisma.member.findMany({
      where: { userId: session.user.id },
      include: {
        organization: {
          select: { id: true, name: true, slug: true, logo: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return memberships.map((membership) => membership.organization);
  }
);

// ─── Member Role ─────────────────────────────────────────

// getActiveMemberRole was removed: it resolved the role from
// session.activeOrganizationId (with a silent "member" fallback), which gave
// multi-org users the wrong permissions on any org that wasn't session-
// active. Role resolution is per-URL-org via getOrgBySlug/resolveMemberRoleForOrg.

export const checkPermission = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        permissions: z.record(z.string().max(100), z.array(z.string().max(100)).max(20)),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.hasPermission({
      headers,
      body: { permissions: data.permissions },
    });
  });

// ─── Members ─────────────────────────────────────────────

export const getOrgMembers = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    // Read the displayed role and its revision in one snapshot.
    const rows = await getD1().prepare(`SELECT m.id,m.organizationId,m.userId,m.role,m.managementRevision,m.createdAt,
      u.name AS userName,u.email AS userEmail,u.image AS userImage
      FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? ORDER BY m.createdAt ASC,m.id ASC`)
      .bind(data.orgId).all();
    return z.array(organizationMemberRow).parse(rows.results).map(row => ({
      id: row.id, organizationId: row.organizationId, userId: row.userId, role: row.role,
      managementRevision: row.managementRevision, createdAt: new Date(row.createdAt),
      user: { id: row.userId, name: row.userName, email: row.userEmail, image: row.userImage },
    }));
  });

export const updateMemberRole = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ memberId: idSchema, role: roleNameSchema, orgId: idSchema.optional(), ...teamRetryFields }), data),
  )
  .handler(async ({ data }) => {
    const orgId = data.orgId ?? (await getPrisma().member.findUnique({
      where: { id: data.memberId }, select: { organizationId: true },
    }))?.organizationId;
    if (!orgId) throw new Error("Member not found");
    await assertOrgPermission(orgId, "settings:members");

    const auth = getAuth();
    const headers = teamRequestHeaders(data);
    const result = await auth.api.updateMemberRole({
      headers,
      body: { memberId: data.memberId, role: data.role, organizationId: orgId },
    });
    assertTeamCommandSuccess(result);
    return result;
  });

export const removeMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ memberIdOrEmail: z.string().min(1).max(254), orgId: idSchema, ...teamRetryFields }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const auth = getAuth();
    const headers = teamRequestHeaders(data);
    const result = await auth.api.removeMember({
      headers,
      body: {
        memberIdOrEmail: data.memberIdOrEmail,
        organizationId: data.orgId,
      },
    });
    assertTeamCommandSuccess(result);
    return result;
  });

// ─── Invitations ─────────────────────────────────────────

export const inviteMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ email: emailSchema, role: roleNameSchema, orgId: idSchema }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");

    // Plan gating: members + outstanding invitations count against the cap.
    const { checkPlanLimit } = await import("@/lib/plan-limits");
    const prisma = getPrisma();
    const [memberCount, pendingInviteCount] = await Promise.all([
      prisma.member.count({ where: { organizationId: data.orgId } }),
      prisma.invitation.count({
        where: { organizationId: data.orgId, status: "pending" },
      }),
    ]);
    await checkPlanLimit(data.orgId, "members", memberCount + pendingInviteCount);

    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.createInvitation({
      headers,
      body: {
        email: data.email,
        role: data.role as
          | "member" | "admin" | "owner"
          | "td" | "cd" | "pd"
          | "pm" | "tm" | "sm" | "stageManager",
        organizationId: data.orgId,
      },
    });
  });

export const getOrgInvitations = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    return await prisma.invitation.findMany({
      where: { organizationId: data.orgId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
  });

export const cancelInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ invitationId: idSchema, requestId: z.uuid().optional() }), data))
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const invitation = await prisma.invitation.findUnique({
      where: { id: data.invitationId },
      select: { organizationId: true },
    });
    if (!invitation) throw new Error("Invitation not found");
    await assertOrgPermission(invitation.organizationId, "settings:members");

    const auth = getAuth();
    const headers = teamRequestHeaders(data);
    const result = await auth.api.cancelInvitation({
      headers,
      body: { invitationId: data.invitationId },
    });
    assertTeamCommandSuccess(result);
    return result;
  });

export const getUserInvitations = createServerFn({ method: "GET" }).handler(
  () => withPrimaryDatabase(async () => {
    setResponseHeader("Cache-Control", "private, no-store");
    const auth = getAuth();
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return [];
    const prisma = getPrisma();
    const invitations = await prisma.invitation.findMany({
      where: { email: session.user.email, status: "pending" },
      include: { organization: { select: { id: true, name: true, slug: true, logo: true } } },
      orderBy: { createdAt: "desc" },
    });
    return invitations.map(invitation => ({ ...invitation, emailVerified: session.user.emailVerified }));
  })
);

export const getInvitationDetails = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(idSchema, data))
  .handler(async ({ data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await withPrimaryDatabase(() => getAuth().api.getSession({ headers: getRequestHeaders(), query: { disableCookieCache: true } }));
    const { readInvitationView } = await import("./invitation-response.server");
    return readInvitationView(getD1(), session?.user ?? null, data);
  });

export const acceptInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(idSchema, data))
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return checkedInvitationResponse(await auth.api.acceptInvitation({
      headers,
      body: { invitationId: data },
      asResponse: true,
    }));
  });

export const rejectInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(idSchema, data))
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return checkedInvitationResponse(await auth.api.rejectInvitation({
      headers,
      body: { invitationId: data },
      asResponse: true,
    }));
  });

async function checkedInvitationResponse(response: Response) {
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ message: z.string() }).safeParse(value);
    throw new Error(error.success ? error.data.message : "Your response could not be confirmed. Check the invitation status before retrying.");
  }
  return z.object({
    invitation: z.object({ id: idSchema, organizationId: idSchema, status: z.enum(["accepted", "rejected"]) }),
    member: z.object({ id: idSchema, organizationId: idSchema, userId: idSchema, role: z.string() }).nullable(),
  }).parse(value);
}
