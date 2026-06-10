/**
 * Super Admin — Platform-level queries across all orgs.
 * Only accessible by the hardcoded super admin email.
 */

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth";
import { sendEmail, waitlistInviteEmail } from "@/lib/email";
import { getPrisma } from "@/lib/db";
import { z } from "zod";
import { emailSchema, idSchema, parseOrThrow } from "@/lib/validation";

export const SUPER_ADMIN_EMAIL = "reydisse@gmail.com";

/** Verify the current request is from the super admin. Throws if not. */
async function requireSuperAdmin() {
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session || session.user.email !== SUPER_ADMIN_EMAIL) {
    throw new Error("Unauthorized");
  }
  return session.user;
}

// ─── All Users ──────────────────────────────────────────────

export const getAllUsers = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        createdAt: true,
      },
    });
    return users;
  },
);

// ─── All Organizations ──────────────────────────────────────

export const getAllOrgs = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    const orgs = await prisma.organization.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        createdAt: true,
      },
    });

    // Get member counts
    const members = await prisma.member.groupBy({
      by: ["organizationId"],
      _count: { id: true },
    });
    const countMap = new Map(
      members.map((m) => [m.organizationId, m._count.id]),
    );

    return orgs.map((org) => ({
      ...org,
      memberCount: countMap.get(org.id) ?? 0,
    }));
  },
);

// ─── All Members (user → org mapping) ───────────────────────

export const getAllMembers = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    return await prisma.member.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { id: true, name: true, email: true } },
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
  },
);

// ─── Recent Sessions ────────────────────────────────────────

export const getRecentSessions = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    return await prisma.session.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        userId: true,
        createdAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
        user: { select: { name: true, email: true } },
      },
    });
  },
);

// ─── Pending Invitations ────────────────────────────────────

export const getAllInvitations = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    return await prisma.invitation.findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "desc" },
      include: {
        organization: { select: { name: true, slug: true } },
      },
    });
  },
);

// ─── Waitlist ───────────────────────────────────────────

export const getWaitlistSignups = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    return await prisma.waitlistSignup.findMany({
      orderBy: { createdAt: "desc" },
    });
  },
);

export const sendWaitlistInvite = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({ id: idSchema, email: emailSchema, name: z.string().max(100) }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await requireSuperAdmin();
    const signupUrl = "https://showpilot.tech/login";
    const { subject, html } = waitlistInviteEmail(data.name, signupUrl);
    await sendEmail({ to: data.email, subject, html });
    return { sent: true };
  });

export const deleteWaitlistSignup = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ id: idSchema }), data))
  .handler(async ({ data }) => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    await prisma.waitlistSignup.delete({ where: { id: data.id } });
  });

// ─── Platform Stats ─────────────────────────────────────────

export const getPlatformStats = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    const [userCount, orgCount, memberCount, sessionCount, invitationCount, waitlistCount] =
      await Promise.all([
        prisma.user.count(),
        prisma.organization.count(),
        prisma.member.count(),
        prisma.session.count(),
        prisma.invitation.count({ where: { status: "pending" } }),
        prisma.waitlistSignup.count(),
      ]);
    return { userCount, orgCount, memberCount, sessionCount, invitationCount, waitlistCount };
  },
);
