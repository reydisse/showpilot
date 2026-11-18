import { resolveWorkspaceType } from "@showpilot/shared";
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
import { APP_ORIGIN } from "@/lib/domain-routing";
import { emailSchema, idSchema, parseOrThrow } from "@/lib/validation";
import {
  PUBLIC_LAUNCH_DATE_KEY,
  getEffectivePlan,
  getPublicLaunchDate,
} from "@/lib/plan-limits";

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
    const [orgs, publicLaunchDate] = await Promise.all([
      prisma.organization.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          createdAt: true,
          plan: true,
          trialEndsAt: true,
          betaTester: true,
          foundingMember: true,
          subscriptionStatus: true,
        },
      }),
      getPublicLaunchDate(),
    ]);

    // Get member counts
    const members = await prisma.member.groupBy({
      by: ["organizationId"],
      _count: { id: true },
    });
    const countMap = new Map(
      members.map((m) => [m.organizationId, m._count.id]),
    );

    const workspaceSettings = await prisma.appSetting.findMany({
      where: {
        orgId: { in: orgs.map((org) => org.id) },
        key: { in: ["workspace-type", "terminology-profile"] },
      },
      select: { orgId: true, key: true, value: true },
    });
    const profiles = new Map<string, Record<string, string>>();
    for (const setting of workspaceSettings) {
      const settings = profiles.get(setting.orgId) ?? {};
      settings[setting.key] = setting.value;
      profiles.set(setting.orgId, settings);
    }
    return orgs.map((org) => ({
      workspaceType: resolveWorkspaceType(profiles.get(org.id) ?? {}),
      ...org,
      memberCount: countMap.get(org.id) ?? 0,
      effectivePlan: getEffectivePlan(org, publicLaunchDate),
    }));
  },
);

// ─── Billing controls (beta access + launch date) ───────────

export const getPublicLaunchSetting = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireSuperAdmin();
    const date = await getPublicLaunchDate();
    return { publicLaunchDate: date?.toISOString() ?? null };
  },
);

export const setOrgBetaTester = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(z.object({ orgId: idSchema, betaTester: z.boolean() }), data),
  )
  .handler(async ({ data }) => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    await prisma.organization.update({
      where: { id: data.orgId },
      data: { betaTester: data.betaTester },
    });
  });

export const setPublicLaunchDate = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    parseOrThrow(
      z.object({
        // ISO date or datetime; null clears the launch date (beta stays open).
        date: z.string().max(40).nullable(),
      }),
      data,
    ),
  )
  .handler(async ({ data }) => {
    await requireSuperAdmin();
    const prisma = getPrisma();

    if (data.date === null) {
      await prisma.platformSetting.deleteMany({
        where: { key: PUBLIC_LAUNCH_DATE_KEY },
      });
      return { publicLaunchDate: null };
    }

    const parsed = new Date(data.date);
    if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date");
    const value = parsed.toISOString();
    await prisma.platformSetting.upsert({
      where: { key: PUBLIC_LAUNCH_DATE_KEY },
      update: { value },
      create: { key: PUBLIC_LAUNCH_DATE_KEY, value },
    });
    return { publicLaunchDate: value };
  });

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
    const signupUrl = `${APP_ORIGIN}/login`;
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


// All insight endpoints are read-only and independently authorize the request.
const auditInput = z.object({
  orgId: idSchema.optional(), actorUserId: idSchema.optional(),
  source: z.enum(["bridge-credential", "scoped-token", "permission"]).optional(),
  search: z.string().max(200).optional(),
  from: z.number().finite().optional(), to: z.number().finite().optional(),
  page: z.number().int().min(0).max(100000).default(0),
});

async function queryAudit(data: z.infer<typeof auditInput>, limit = 50) {
  const { requestDatabase } = await import("./request-database.server");
  const union = `SELECT 'bridge:' || id AS id, orgId, actorUserId,
    action || ' ' || direction AS action, 'bridge-credential' AS source,
    credentialId AS target, createdAt AS createdAtMs FROM bridge_credential_audit
    UNION ALL SELECT 'token:' || id, orgId, actorUserId, action, 'scoped-token',
    kind || ' ' || tokenId, createdAt FROM scoped_token_audit
    UNION ALL SELECT 'grant:' || id, orgId, grantedByUserId, 'permission granted',
    'permission', userId || ' ' || capability, CASE WHEN typeof(createdAt) IN ('integer','real') THEN createdAt ELSE CAST((julianday(createdAt)-2440587.5)*86400000 AS INTEGER) END FROM member_permission_grant
    UNION ALL SELECT 'revoke:' || id, orgId, revokedByUserId, 'permission revoked',
    'permission', userId || ' ' || capability, CASE WHEN typeof(revokedAt) IN ('integer','real') THEN revokedAt ELSE CAST((julianday(revokedAt)-2440587.5)*86400000 AS INTEGER) END FROM member_permission_grant WHERE revokedAt IS NOT NULL`;
  const base = `WITH events AS (${union}), normalized AS (
    SELECT e.*, o.name AS orgName, COALESCE(NULLIF(u.name, ''), u.email, e.actorUserId, 'system') AS actorLabel
    FROM events e LEFT JOIN organization o ON o.id = e.orgId LEFT JOIN user u ON u.id = e.actorUserId)
    SELECT * FROM normalized WHERE 1=1`;
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  for (const [column, value] of [["orgId", data.orgId], ["actorUserId", data.actorUserId], ["source", data.source]] as const) {
    if (value) { clauses.push(` AND ${column} = ?`); values.push(value); }
  }
  if (data.from !== undefined) { clauses.push(" AND createdAtMs >= ?"); values.push(data.from); }
  if (data.to !== undefined) { clauses.push(" AND createdAtMs <= ?"); values.push(data.to); }
  if (data.search) {
    clauses.push(" AND (instr(lower(action), lower(?)) > 0 OR instr(lower(target), lower(?)) > 0 OR instr(lower(actorLabel), lower(?)) > 0)");
    values.push(data.search, data.search, data.search);
  }
  const filtered = base + clauses.join("");
  type Event = { id: string; orgId: string; orgName: string; actorUserId: string | null; actorLabel: string; action: string; source: string; target: string; createdAtMs: number };
  const [rows, count] = await Promise.all([
    requestDatabase.prepare(filtered + " ORDER BY createdAtMs DESC, id ASC LIMIT ? OFFSET ?").bind(...values, limit, data.page * 50).all<Event>(),
    requestDatabase.prepare(`SELECT COUNT(*) AS total FROM (${filtered})`).bind(...values).first<{ total: number }>(),
  ]);
  return { events: rows.results, total: count?.total ?? 0 };
}

export const getAuditLog = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(auditInput, data))
  .handler(async ({ data }) => { await requireSuperAdmin(); return queryAudit(data); });

export const getOrg360 = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await requireSuperAdmin();
    const prisma = getPrisma();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: data.orgId } });
    const [members, shows, devices, bridges, activity, launch] = await Promise.all([
      prisma.member.findMany({ where: { organizationId: data.orgId }, select: { id: true, role: true, user: { select: { name: true, email: true } } } }),
      prisma.rundown.findMany({ where: { orgId: data.orgId }, orderBy: { serviceDate: "desc" }, select: { id: true, name: true, serviceDate: true, status: true } }),
      prisma.device.findMany({ where: { orgId: data.orgId }, select: { id: true, name: true, category: true, enabled: true } }),
      prisma.bridgeInstallation.findMany({ where: { orgId: data.orgId }, select: { id: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true } }),
      queryAudit({ orgId: data.orgId, page: 0 }, 20), getPublicLaunchDate(),
    ]);
    return { profile: { name: org.name, slug: org.slug, createdAt: org.createdAt, cloud_enabled: org.cloud_enabled },
      billing: { plan: org.plan, effectivePlan: getEffectivePlan(org, launch), trialEndsAt: org.trialEndsAt,
        subscriptionStatus: org.subscriptionStatus, foundingMember: org.foundingMember, betaTester: org.betaTester,
        hasStripeCustomer: !!org.stripeCustomerId, hasStripeSubscription: !!org.stripeSubscriptionId },
      members, shows, showCount: shows.length, devices, bridges: bridges.map(b => ({ ...b, createdAt: Number(b.createdAt), lastUsedAt: b.lastUsedAt === null ? null : Number(b.lastUsedAt), revokedAt: b.revokedAt === null ? null : Number(b.revokedAt) })), activity: activity.events };
  });

export const getFeatureUsage = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30) }), data))
  .handler(async ({ data }) => {
    await requireSuperAdmin();
    const { requestDatabase } = await import("./request-database.server");
    const to = Date.now(), from = to - data.days * 86400000;
    const features = [
      ["Rundowns", "rundown", "createdAt"], ["Chat messages", "chat_message", "createdAt"],
      ["Check-ins", "checklist_entry", "checkedAt"], ["Cue sheets", "cue_sheet", "createdAt"],
      ["Incidents", "incident", "timestamp"], ["Graphics templates", "graphic_template", "createdAt"],
      ["Songs", "song", "createdAt"], ["Crew assignments", "service_assignment", "createdAt"],
      ["Webhook events", "webhook_event", "timestamp"], ["Bridge activity", "bridge_installation", "lastUsedAt"],
    ] as const;
    const orgs = await getPrisma().organization.findMany({ select: { id: true, name: true } });
    const counts = await Promise.all(features.map(async ([feature, table, timestamp]) => {
      const iso = table === "webhook_event";
      const time = iso ? timestamp : `CASE WHEN typeof(${timestamp}) IN ('integer','real') THEN ${timestamp} ELSE CAST((julianday(${timestamp})-2440587.5)*86400000 AS INTEGER) END`;
      const rows = await requestDatabase.prepare(`SELECT orgId, COUNT(*) AS count FROM ${table}
        WHERE ${time} >= ? AND ${time} <= ? ${table === "checklist_entry" ? "AND checked = 1" : ""} GROUP BY orgId`)
        .bind(iso ? new Date(from).toISOString() : from, iso ? new Date(to).toISOString() : to).all<{ orgId: string; count: number }>();
      return { feature, rows: rows.results };
    }));
    return { days: data.days, from, to,
      summary: counts.map(({ feature, rows }) => ({ feature, total: rows.reduce((sum, row) => sum + row.count, 0), activeOrgs: rows.length })).sort((a, b) => b.total - a.total),
      orgs: orgs.map(org => ({ ...org, counts: Object.fromEntries(counts.map(({ feature, rows }) => [feature, rows.find(row => row.orgId === org.id)?.count ?? 0])) })) };
  });
