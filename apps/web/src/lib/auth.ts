import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getPrisma } from "@/lib/db";
import { ac, roles } from "@/lib/permissions";

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
    // Log-only for now — admins copy invite links from team page
    console.log(
      `Invite ${data.email} to ${data.organization.name}: /invite/${data.id}`
    );
  },
};

// Static instance for Better Auth CLI schema generation only.
// Do NOT use this at runtime — use getAuth() instead.
export const auth = betterAuth({
  database: prismaAdapter(undefined as any, { provider: "sqlite" }),
  plugins: [organization(orgConfig)],
  emailAndPassword: { enabled: true },
});

// Runtime instance — creates a fresh Better Auth backed by D1 via Prisma.
// Called per-request in Cloudflare Workers since env bindings are request-scoped.
export function getAuth() {
  const prisma = getPrisma();
  return betterAuth({
    trustedOrigins: ["http://192.168.2.73:5173"],
    database: prismaAdapter(prisma, { provider: "sqlite" }),
    plugins: [
      organization(orgConfig),
      tanstackStartCookies(), // must be last
    ],
    emailAndPassword: { enabled: true },
  });
}
