import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getPrisma } from "@/lib/db";
import { ac, roles } from "@/lib/permissions";
import {
  sendEmail,
  passwordResetEmail,
  invitationEmail,
} from "@/lib/email";

const orgConfig = {
  allowUserToCreateOrganization: true,
  creatorRole: "owner" as const,
  membershipLimit: 100,
  ac,
  roles,
  dynamicAccessControl: {
    enabled: true,
    maximumRolesPerOrganization: 20,
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
export function getAuth() {
  const prisma = getPrisma();
  return betterAuth({
    trustedOrigins: [
      "http://192.168.2.73:5173",
      "https://showpilot.tech",
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
