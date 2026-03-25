import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";

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
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.getSession({ headers });
  }
);

export const getSessionWithOrg = createServerFn({ method: "GET" }).handler(
  async () => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    const session = await auth.api.getSession({ headers });
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
    const prisma = getPrisma();
    return await prisma.organization.findUnique({
      where: { slug: data },
    });
  });

export const setActiveOrg = createServerFn({ method: "POST" })
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    await auth.api.setActiveOrganization({
      headers,
      body: { organizationId: data },
    });
  });

export const listUserOrgs = createServerFn({ method: "GET" }).handler(
  async () => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.listOrganizations({ headers });
  }
);

// ─── Member Role ─────────────────────────────────────────

export const getActiveMemberRole = createServerFn({ method: "GET" }).handler(
  async () => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    try {
      const result = await auth.api.getActiveMemberRole({ headers });
      return result?.role ?? "member";
    } catch {
      return "member";
    }
  }
);

export const checkPermission = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { permissions: Record<string, string[]> }) => data
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
    const prisma = getPrisma();
    const members = await prisma.member.findMany({
      where: { organizationId: data.orgId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: "asc" },
    });
    return members;
  });

export const updateMemberRole = createServerFn({ method: "POST" })
  .inputValidator((data: { memberId: string; role: string }) => data)
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.updateMemberRole({
      headers,
      body: { memberId: data.memberId, role: data.role },
    });
  });

export const removeMember = createServerFn({ method: "POST" })
  .inputValidator((data: { memberIdOrEmail: string; orgId: string }) => data)
  .handler(async ({ data }) => {
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
  .inputValidator(
    (data: { email: string; role: string; orgId: string }) => data
  )
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.createInvitation({
      headers,
      body: {
        email: data.email,
        role: data.role as "member" | "admin" | "owner",
        organizationId: data.orgId,
      },
    });
  });

export const getOrgInvitations = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    return await prisma.invitation.findMany({
      where: { organizationId: data.orgId, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
  });

export const cancelInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: { invitationId: string }) => data)
  .handler(async ({ data }) => {
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
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.acceptInvitation({
      headers,
      body: { invitationId: data },
    });
  });

export const rejectInvitation = createServerFn({ method: "POST" })
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    const auth = getAuth();
    const headers = getRequestHeaders();
    return await auth.api.rejectInvitation({
      headers,
      body: { invitationId: data },
    });
  });
