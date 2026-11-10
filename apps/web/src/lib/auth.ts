import { betterAuth } from "better-auth";
import { createAuthEndpoint, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { createOrganizationAtomically, readOrganizationCreation, OrganizationCreationReceiptError } from "./organization-creation.server";
import { z } from "zod";
import { creationRequestIdSchema } from "./organization-creation-contract";
import { idSchema, orgSlugSchema } from "./validation";
import { respondToInvitationAtomically, InvitationResponseError, type InvitationDecision } from "./invitation-response.server";
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
// origin checks and cookie/plugin hooks. Creation and invitation responses use
// atomic D1 storage instead of Prisma's unsupported interactive transactions.
function showPilotOrganization() {
  const plugin = organization(orgConfig);
  const original = plugin.endpoints.createOrganization;
  const responseEndpoint = (endpoint: typeof plugin.endpoints.acceptInvitation | typeof plugin.endpoints.rejectInvitation, decision: InvitationDecision) =>
    createAuthEndpoint(endpoint.path, endpoint.options, async ctx => {
      ctx.setHeader("Cache-Control", "private, no-store");
      const failure = (status: 400 | 401 | 403 | 404 | 409 | 500, code: string, message: string) => {
        ctx.setStatus(status); return ctx.json({ code, message });
      };
      const session = await getAuthoritativeSessionFromCtx(ctx);
      if (!session) return failure(401, "UNAUTHORIZED", "Sign in before responding to this invitation.");
      const parsed = idSchema.safeParse(ctx.body.invitationId);
      if (!parsed.success) return failure(400, "INVALID_INVITATION", "This invitation link is invalid.");
      try {
        const result = await respondToInvitationAtomically(getD1(), { userId: session.user.id, sessionId: session.session.id }, parsed.data, decision);
        if (result.member) await refreshMemberAuthority({ member: result.member });
        return ctx.json(result);
      } catch (error) {
        if (error instanceof InvitationResponseError) return failure(error.status, error.code, error.message);
        console.error("[auth] invitation response transaction failed", error);
        return failure(500, "INVITATION_RESPONSE_UNCONFIRMED", "Your response could not be confirmed. Check the invitation status before retrying.");
      }
    });
  return {
    ...plugin,
    endpoints: {
      ...plugin.endpoints,
      acceptInvitation: responseEndpoint(plugin.endpoints.acceptInvitation, "accepted"),
      rejectInvitation: responseEndpoint(plugin.endpoints.rejectInvitation, "rejected"),
      createOrganization: createAuthEndpoint(original.path, original.options, async ctx => {
        const failure = (status: 400 | 401 | 403 | 409 | 410 | 500, code: string, message: string) => {
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
        const key = ctx.headers?.get("Idempotency-Key");
        const setup = ctx.headers?.get("X-ShowPilot-Setup");
        if ((key !== null && key !== undefined && !creationRequestIdSchema.safeParse(key).success)
          || (setup !== null && setup !== undefined && (setup !== "1" || !key))) {
          return failure(400, "INVALID_CREATION_REQUEST", "Use a valid creation request before continuing.");
        }
        const db = getD1();
        let created;
        try {
          created = await createOrganizationAtomically(db, { userId: session.user.id, sessionId: session.session.id }, { ...ctx.body, name }, { requestId: key ?? undefined, setup: setup === "1" });
        } catch (error) {
          if (error instanceof OrganizationCreationReceiptError) {
            return failure(error.code === "mismatch" ? 409 : error.code === "removed" ? 410 : 403,
              `ORGANIZATION_CREATION_${error.code.toUpperCase()}`, error.message);
          }
          // Only the unique-address constraint proves a rolled-back conflict.
          // A receipt read can fail after commit, when this address is already ours.
          if (error instanceof Error && error.message.includes("UNIQUE constraint failed: organization.slug")) {
            return failure(400, "ORGANIZATION_ALREADY_EXISTS", "This workspace address is already in use.");
          }
          console.error("[auth] organization creation transaction failed", error);
          return failure(500, "ORGANIZATION_CREATION_UNCONFIRMED", "Organization creation was not confirmed. Check your workspaces before retrying.");
        }
        if (!created) return failure(401, "UNAUTHORIZED", "Your account changed. Sign in again before creating an organization.");
        return ctx.json(created);
      }),
      getOrganizationCreation: createAuthEndpoint("/organization/creation-result", {
        method: "GET", query: z.object({ requestId: creationRequestIdSchema }),
      }, async ctx => {
        ctx.setHeader("Cache-Control", "private, no-store");
        const session = await getAuthoritativeSessionFromCtx(ctx);
        if (!session) { ctx.setStatus(401); return ctx.json({ code: "UNAUTHORIZED", message: "Sign in to check your workspace." }); }
        try {
          return ctx.json(await readOrganizationCreation(getD1(), session.user.id, ctx.query.requestId));
        } catch {
          ctx.setStatus(503); return ctx.json({ code: "CREATION_RESULT_UNAVAILABLE", message: "Could not check the saved workspace. Try again." });
        }
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
