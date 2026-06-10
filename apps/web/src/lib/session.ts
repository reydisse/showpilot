import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { z } from "zod";
import { emailSchema, idSchema, parseOrThrow } from "@/lib/validation";

// Role names are org-defined (dynamic access control) — bound, not enumerated.
const roleNameSchema = z.string().min(1).max(50);

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

    const member = await prisma.member.findFirst({
      where: {
        organizationId: org.id,
        userId: session.user.id,
      },
      select: { id: true },
    });

    return member ? org : null;
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

export const getActiveMemberRole = createServerFn({ method: "GET" }).handler(
  async () => {
    try {
      const session = await getSessionOrThrow();
      const prisma = getPrisma();

      const activeOrgId = session.session.activeOrganizationId;
      if (activeOrgId) {
        const activeMember = await prisma.member.findFirst({
          where: { organizationId: activeOrgId, userId: session.user.id },
          select: { role: true },
        });
        const normalized = normalizeRole(activeMember?.role ?? null);
        if (normalized) return normalized;
      }

      const firstMember = await prisma.member.findFirst({
        where: { userId: session.user.id },
        orderBy: { createdAt: "asc" },
        select: { role: true },
      });
      return normalizeRole(firstMember?.role ?? null) ?? "member";
    } catch {
      return "member";
    }
  }
);

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
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    const members = await prisma.member.findMany({
      where: { organizationId: data.orgId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: "asc" },
    });
    return members;
  });

export const updateMemberRole = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ memberId: idSchema, role: roleNameSchema }), data),
  )
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const member = await prisma.member.findUnique({
      where: { id: data.memberId },
      select: { organizationId: true },
    });
    if (!member) throw new Error("Member not found");
    await assertOrgPermission(member.organizationId, "settings:members");

    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.updateMemberRole({
      headers,
      body: { memberId: data.memberId, role: data.role },
    });
  });

export const removeMember = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ memberIdOrEmail: z.string().min(1).max(254), orgId: idSchema }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.removeMember({
      headers,
      body: {
        memberIdOrEmail: data.memberIdOrEmail,
        organizationId: data.orgId,
      },
    });
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
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.createInvitation({
      headers,
      body: {
        email: data.email,
        role: data.role as "member" | "admin" | "owner" | "pm" | "tm" | "sm" | "stageManager",
        organizationId: data.orgId,
      },
    });
  });

export const getOrgInvitations = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "settings:members");
    const prisma = getPrisma();
    return await prisma.invitation.findMany({
      where: { organizationId: data.orgId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
  });

export const cancelInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ invitationId: idSchema }), data))
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const invitation = await prisma.invitation.findUnique({
      where: { id: data.invitationId },
      select: { organizationId: true },
    });
    if (!invitation) throw new Error("Invitation not found");
    await assertOrgPermission(invitation.organizationId, "settings:members");

    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.cancelInvitation({
      headers,
      body: { invitationId: data.invitationId },
    });
  });

export const getUserInvitations = createServerFn({ method: "GET" }).handler(
  async () => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });
    if (!session) return [];
    const prisma = getPrisma();
    const invitations = await prisma.invitation.findMany({
      where: { email: session.user.email, status: "pending" },
      include: { organization: { select: { id: true, name: true, slug: true, logo: true } } },
      orderBy: { createdAt: "desc" },
    });
    return invitations;
  }
);

export const getInvitationDetails = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.invitation.findUnique({
      where: { id: data },
      include: {
        organization: { select: { id: true, name: true, slug: true, logo: true } },
        user: { select: { name: true, email: true } },
      },
    });
  });

export const acceptInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(idSchema, data))
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.acceptInvitation({
      headers,
      body: { invitationId: data },
    });
  });

export const rejectInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(idSchema, data))
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.rejectInvitation({
      headers,
      body: { invitationId: data },
    });
  });
