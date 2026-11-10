import { betterAuth } from "better-auth";
import { createAuthEndpoint, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { createOrganizationAtomically } from "./organization-creation.server";
import { orgSlugSchema } from "./validation";
import { getD1 } from "./d1";
import { expo } from "@better-auth/expo";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getPrisma } from "@/lib/db";
import { authAccessControl, authRoles } from "@/lib/auth-access";
import { getDevelopmentTrustedOrigins, requireBetterAuthRuntimeConfig, requireShowPilotBaseUrl } from "@/lib/auth-origins";
import { verificationEmailCallback } from "@/lib/auth-navigation";
import { createD1RateLimitStorage } from "@/lib/auth-rate-limit.server";
import { PASSWORD_MIN_LENGTH } from "@showpilot/shared";
import {
  sendEmail,
  passwordResetEmail,
  invitationEmail,
  verificationEmail,
} from "@/lib/email";
import { sendInvitationWithSetupReceipt } from "./setup-invitation-delivery.server";
import { beforeDeleteAccount } from "@/lib/account-deletion.server";
import { env } from "cloudflare:workers";
import { refreshOrgReadAuthority, refreshUserReadAuthority } from "./relay-read-invalidation.server";

const refreshMemberAuthority = ({ member }: { member: { organizationId: string; userId: string } }) =>
  refreshOrgReadAuthority(member.organizationId, member.userId);

const orgConfig = {
  // Login is allowed pre-verification (with a banner prompt), but creating
  // an organization requires a verified email.
  allowUserToCreateOrganization: (user: { emailVerified?: boolean }) =>
    user.emailVerified === true,
  creatorRole: "owner" as const,
  membershipLimit: async (_user: unknown, organization: { id: string }) => {
    const { getPlanMemberLimitForOrg } = await import("@/lib/plan-limits");
    return getPlanMemberLimitForOrg(organization.id);
  },
  invitationLimit: async (data: { organization: { id: string } }) => {
    const { getPlanMemberLimitForOrg } = await import("@/lib/plan-limits");
    const prisma = getPrisma();
    const [limit, memberCount] = await Promise.all([
      getPlanMemberLimitForOrg(data.organization.id),
      prisma.member.count({ where: { organizationId: data.organization.id } }),
    ]);
    return Math.max(0, limit - memberCount);
  },
  // Organization deletion is intentionally exposed only through the guarded
  // ShowPilot workflow, which requires a recent session, typed-name
  // confirmation, subscription cancellation, and owned-storage cleanup.
  disableOrganizationDeletion: true,
  ac: authAccessControl,
  roles: authRoles,
  dynamicAccessControl: {
    enabled: true,
    maximumRolesPerOrganization: 20,
  },
  organizationHooks: {
    afterAddMember: refreshMemberAuthority,
    afterAcceptInvitation: refreshMemberAuthority,
    afterRemoveMember: refreshMemberAuthority,
    afterUpdateMemberRole: refreshMemberAuthority,
  },
  sendInvitationEmail: async (data: {
    id: string;
    email: string;
    organization: { id: string; name: string };
    inviter: { user: { name: string } };
  }) => {
    const inviteUrl = new URL(
      `/invite/${encodeURIComponent(data.id)}`,
      requireShowPilotBaseUrl(env.BETTER_AUTH_URL),
    ).href;
    const { subject, html } = invitationEmail(
      data.organization.name,
      data.inviter.user.name,
      inviteUrl,
    );
    await sendInvitationWithSetupReceipt({ orgId: data.organization.id, email: data.email, invitationId: data.id,
      send: signal => sendEmail({ to: data.email, subject, html, signal }),
    });
  },
};

const emailPasswordConfig = {
  enabled: true,
  minPasswordLength: PASSWORD_MIN_LENGTH,
  sendResetPassword: async (data: {
    user: { email: string };
    url: string;
    token: string;
  }) => {
    const { subject, html } = passwordResetEmail(data.url);
    await sendEmail({ to: data.user.email, subject, html });
  },
};

// Keep Better Auth's endpoint schema, organization middleware, HTTP rate limits,
// origin checks and cookie/plugin hooks. Only creation's storage operation changes.
function showPilotOrganization() {
  const plugin = organization(orgConfig);
  const original = plugin.endpoints.createOrganization;
  return {
    ...plugin,
    endpoints: {
      ...plugin.endpoints,
      createOrganization: createAuthEndpoint(original.path, original.options, async ctx => {
        const failure = (status: 400 | 401 | 403 | 500, code: string, message: string) => {
          ctx.setStatus(status);
          return ctx.json({ code, message });
        };
        const session = await getAuthoritativeSessionFromCtx(ctx);
        if (!session) return failure(401, "UNAUTHORIZED", "Sign in to create an organization.");
        if (!orgConfig.allowUserToCreateOrganization(session.user)) {
          return failure(403, "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION", "Verify your email to create an organization.");
        }
        const name = ctx.body.name.trim();
        if (!name || name.length > 160 || !orgSlugSchema.safeParse(ctx.body.slug).success) {
          return failure(400, "INVALID_ORGANIZATION", "Enter an organization name and a valid workspace address.");
        }
        const db = getD1();
        let created;
        try {
          created = await createOrganizationAtomically(db, { userId: session.user.id, sessionId: session.session.id }, { ...ctx.body, name });
        } catch (error) {
          const taken = await db.prepare("SELECT id FROM organization WHERE slug = ?").bind(ctx.body.slug).first();
          if (taken) return failure(400, "ORGANIZATION_ALREADY_EXISTS", "This workspace address is already in use.");
          console.error("[auth] organization creation transaction failed", error);
          return failure(500, "ORGANIZATION_CREATION_UNCONFIRMED", "Organization creation was not confirmed. Check your workspaces before retrying.");
        }
        if (!created) return failure(401, "UNAUTHORIZED", "Your account changed. Sign in again before creating an organization.");
        return ctx.json(created);
      }),
    },
  };
}

// Static instance for Better Auth CLI schema generation only.
// Do NOT use this at runtime — use getAuth() instead.
export const auth = betterAuth({
  database: prismaAdapter(undefined as any, { provider: "sqlite" }),
  plugins: [expo(), showPilotOrganization()],
  emailAndPassword: emailPasswordConfig,
});

// Runtime instance — creates a fresh Better Auth backed by D1 via Prisma.
// Called per-request in Cloudflare Workers since env bindings are request-scoped.
//
// IMPORTANT: We must explicitly pass `baseURL` and `secret` from the Cloudflare
// Workers env bindings. Better Auth tries to read these from `process.env`, but
// Cloudflare Workers do NOT populate `process.env` with secrets/bindings —
// they are only available via `import { env } from "cloudflare:workers"`.
// Without explicit values, Better Auth falls back to a default secret and
// cannot determine the base URL, which causes cookie signing mismatches and
// the __Secure- cookie prefix to be applied inconsistently.
export function getAuth() {
  const prisma = getPrisma();
  const cfEnv = env as unknown as Record<string, unknown>;
  const database = cfEnv.DB as D1Database;
  const { baseURL, secret } = requireBetterAuthRuntimeConfig(cfEnv);

  return betterAuth({
    baseURL,
    secret,
    // Durable D1-backed protection against credential stuffing and signup
    // abuse. The custom storage uses one atomic SQLite statement because D1
    // cannot run Prisma's interactive increment transaction.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
      customStorage: createD1RateLimitStorage(database),
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
        ipv6Subnet: 64,
      },
    },
    trustedOrigins: [
      "https://app.showpilot.tech",
      "https://showpilot.tech",
      "https://www.showpilot.tech",
      "https://admin.showpilot.tech",
      "https://*.showpilot.tech",
      "https://showpilot.reydisse.workers.dev",
      "showpilot://",
      "showpilot://*",
      ...getDevelopmentTrustedOrigins(baseURL),
    ],
    database: prismaAdapter(prisma, { provider: "sqlite" }),
    databaseHooks: {
      session: { delete: { after: session => refreshUserReadAuthority(session.userId) } },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        // Land on our confirmation page once the token is consumed.
        const verifyUrl = new URL(url);
        verifyUrl.searchParams.set("callbackURL", verificationEmailCallback(verifyUrl.searchParams.get("callbackURL"), baseURL));
        const { subject, html } = verificationEmail(verifyUrl.toString());
        await sendEmail({ to: user.email, subject, html });
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: beforeDeleteAccount,
      },
    },
    plugins: [
      expo(),
      showPilotOrganization(),
      tanstackStartCookies(), // must be last
    ],
    emailAndPassword: emailPasswordConfig,
  });
}
