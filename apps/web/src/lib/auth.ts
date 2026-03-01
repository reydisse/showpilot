import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getPrisma } from "@/lib/db";

// Static instance for Better Auth CLI schema generation only.
// Do NOT use this at runtime — use getAuth() instead.
export const auth = betterAuth({
  database: prismaAdapter(undefined as any, { provider: "sqlite" }),
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
      membershipLimit: 100,
    }),
  ],
  emailAndPassword: { enabled: true },
});

// Runtime instance — creates a fresh Better Auth backed by D1 via Prisma.
// Called per-request in Cloudflare Workers since env bindings are request-scoped.
export function getAuth() {
  const prisma = getPrisma();
  return betterAuth({
    database: prismaAdapter(prisma, { provider: "sqlite" }),
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: "owner",
        membershipLimit: 100,
      }),
      tanstackStartCookies(), // must be last
    ],
    emailAndPassword: { enabled: true },
  });
}
