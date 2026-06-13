import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";
import { signCompanionToken } from "@/lib/companion-token";
import { z } from "zod";
import { idSchema, labelSchema, parseOrThrow } from "@/lib/validation";

// ─────────────────────────────────────────────────────────────
// Companion / Stream Deck control tokens.
//
// Org-scoped `cmp_` bearer tokens for the Bitfocus Companion Generic HTTP
// module. These authorize WRITE control (transport, lyrics, lower thirds,
// kiosk blanking, stream go-live) so they are HMAC-signed under a SEPARATE
// COMPANION_SECRET — never the kiosk secret. Token crypto lives in the pure
// companion-token.ts; records are stored like kiosk tokens.
// ─────────────────────────────────────────────────────────────

export { COMPANION_TOKEN_PREFIX, signCompanionToken, verifyCompanionToken } from "@/lib/companion-token";

// Companion tokens are org-scoped API credentials, so creating, listing, and
// revoking them requires the same permission as other API keys (kiosk tokens
// use the same one). Returns the caller's userId for createdBy.
async function assertCompanionTokenPermission(orgId: string): Promise<string> {
  const auth = getAuth();
  const headers = getRequestHeaders();
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Unauthorized");

  const prisma = getPrisma();
  const member = await prisma.member.findFirst({
    where: { organizationId: orgId, userId: session.user.id },
    select: { role: true },
  });
  const role = normalizeRole(member?.role ?? null);
  if (!role || !hasPermission(role, "settings:api_keys")) {
    throw new Error("Forbidden");
  }
  return session.user.id;
}

// Fail closed: companion tokens cannot be signed or verified without the
// secret. Set via `wrangler secret put COMPANION_SECRET` (and .dev.vars
// locally). Deliberately distinct from KIOSK_SECRET — see DEPLOY.md.
export function getCompanionSecret(): string {
  const secret = (env as unknown as Record<string, unknown>).COMPANION_SECRET as
    | string
    | undefined;
  if (!secret) throw new Error("COMPANION_SECRET is not configured");
  return secret;
}

// ─── Server Functions ────────────────────────────────────

const createCompanionTokenSchema = z.object({
  orgId: idSchema,
  label: labelSchema,
  expiresInDays: z.number().int().min(1).max(3650).nullable(), // null = permanent
});

export const createCompanionToken = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(createCompanionTokenSchema, data))
  .handler(async ({ data }) => {
    const userId = await assertCompanionTokenPermission(data.orgId);

    const prisma = getPrisma();
    const org = await prisma.organization.findUnique({
      where: { id: data.orgId },
      select: { slug: true },
    });
    if (!org) throw new Error("Organization not found");

    const exp = data.expiresInDays
      ? Math.floor(Date.now() / 1000) + data.expiresInDays * 86400
      : null;

    const payload: Record<string, unknown> = {
      orgId: data.orgId,
      orgSlug: org.slug,
      scope: "companion",
      iat: Math.floor(Date.now() / 1000),
      ...(exp ? { exp } : {}),
    };

    const token = await signCompanionToken(payload, getCompanionSecret());

    const companionToken = await prisma.companionToken.create({
      data: {
        orgId: data.orgId,
        label: data.label,
        token,
        expiresAt: exp ? new Date(exp * 1000) : null,
        createdBy: userId,
      },
    });

    return companionToken;
  });

export const listCompanionTokens = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertCompanionTokenPermission(data.orgId);
    const prisma = getPrisma();
    return await prisma.companionToken.findMany({
      where: { orgId: data.orgId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
  });

export const revokeCompanionToken = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ tokenId: idSchema }), data))
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.companionToken.findUnique({
      where: { id: data.tokenId },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Token not found");
    await assertCompanionTokenPermission(existing.orgId);
    return await prisma.companionToken.update({
      where: { id: data.tokenId },
      data: { revokedAt: new Date() },
    });
  });
