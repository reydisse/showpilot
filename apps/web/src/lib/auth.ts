import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getPrisma } from "@/lib/db";
import { authAccessControl, authRoles } from "@/lib/auth-access";
import {
  sendEmail,
  passwordResetEmail,
  invitationEmail,
} from "@/lib/email";
import { env } from "cloudflare:workers";

const orgConfig = {
  allowUserToCreateOrganization: true,
  creatorRole: "owner" as const,
  membershipLimit: 100,
  ac: authAccessControl,
  roles: authRoles,
  dynamicAccessControl: {
    enabled: true,
    maximumRolesPerOrganization: 20,
  },
  organizationHooks: {
    // Every new org gets a 14-day pro trial, no card required. On expiry
    // the org naturally evaluates as free via getEffectivePlan — no cron.
    afterCreateOrganization: async ({ organization }: { organization: { id: string } }) => {
      try {
        const prisma = getPrisma();
        await prisma.organization.update({
          where: { id: organization.id },
          data: { trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
        });
      } catch (err) {
        // A missing trial must never block org creation.
        console.error("[auth] failed to set trialEndsAt for new org:", err);
      }
    },
  },
  sendInvitationEmail: async (data: {
    id: string;
    email: string;
    organization: { name: string };
    inviter: { user: { name: string } };
  }) => {
    const inviteUrl = `https://showpilot.tech/invite/${data.id}`;
    const { subject, html } = invitationEmail(
      data.organization.name,
      data.inviter.user.name,
      inviteUrl,
    );
    await sendEmail({ to: data.email, subject, html });
  },
};

const emailPasswordConfig = {
  enabled: true,
  sendResetPassword: async (data: {
    user: { email: string };
    url: string;
    token: string;
  }) => {
    console.log("[auth] sendResetPassword called for:", data.user.email, "url:", data.url);
    try {
      const { subject, html } = passwordResetEmail(data.url);
      await sendEmail({ to: data.user.email, subject, html });
      console.log("[auth] sendResetPassword succeeded");
    } catch (err) {
      console.error("[auth] sendResetPassword FAILED:", err);
      throw err;
    }
  },
};

// Static instance for Better Auth CLI schema generation only.
// Do NOT use this at runtime — use getAuth() instead.
export const auth = betterAuth({
  database: prismaAdapter(undefined as any, { provider: "sqlite" }),
  plugins: [organization(orgConfig)],
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
  // Fail closed: never run with a guessable session-signing secret.
  const secret = cfEnv.BETTER_AUTH_SECRET as string | undefined;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured");
  const baseURL = (cfEnv.BETTER_AUTH_URL as string) || "https://showpilot.tech";

  return betterAuth({
    baseURL,
    secret,
    // Code-level minimum against credential stuffing / signup abuse.
    // In-memory storage is per-isolate on Workers; Cloudflare WAF rules
    // provide the durable layer in production.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
    },
    trustedOrigins: [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173",
      "http://192.168.2.73:5173",
      "http://192.168.2.108:3000",
      "http://192.168.2.108:5173",
      "http://192.168.2.73:3000",
      "https://showpilot.tech",
      "https://www.showpilot.tech",
      "https://admin.showpilot.tech",
      "https://*.showpilot.tech",
      "https://showpilot.reydisse.workers.dev",
    ],
    database: prismaAdapter(prisma, { provider: "sqlite" }),
    plugins: [
      organization(orgConfig),
      tanstackStartCookies(), // must be last
    ],
    emailAndPassword: emailPasswordConfig,
  });
}
