import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { getAuth } from "@/lib/auth";
import { getPrisma } from "@/lib/db";
import { hasPermission, normalizeRole } from "@/lib/app-permissions";

// Kiosk tokens are org-scoped API credentials, so creating, listing, and
// revoking them requires the same permission as other API keys. Returns the
// caller's userId (used for createdBy) so callers don't re-fetch the session.
async function assertKioskTokenPermission(orgId: string): Promise<string> {
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

// ─── Types ───────────────────────────────────────────────

export type KioskView = "timer" | "overlay" | "board";

export const KIOSK_VIEWS: Record<KioskView, { label: string; description: string }> = {
  timer: { label: "Stage Timer", description: "Countdown / elapsed timer display" },
  overlay: { label: "Confidence Monitor", description: "Lower thirds overlay preview" },
  board: { label: "Show Board", description: "Read-only production board view" },
};

// ─── Token Generation ────────────────────────────────────
// Simple HMAC-signed token. In production, use a proper JWT
// library. For Cloudflare Workers, we use the Web Crypto API.

async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const data = `${header}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${signature}`;
}

export async function verifyToken(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const data = `${header}.${body}`;
  const encoder = new TextEncoder();
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = Uint8Array.from(
      atob(signature.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(data));
    if (!valid) return null;
    const payload = JSON.parse(
      atob(body.replace(/-/g, "+").replace(/_/g, "/"))
    );
    // Check expiration
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    // Malformed base64 / JSON / crypto input → treat as an invalid token.
    return null;
  }
}

// ─── Server Functions ────────────────────────────────────

// Fail closed: kiosk tokens cannot be signed or verified without the secret.
// Set via `wrangler secret put KIOSK_SECRET` (and .dev.vars locally).
export function getKioskSecret(): string {
  const secret = (env as unknown as Record<string, unknown>).KIOSK_SECRET as
    | string
    | undefined;
  if (!secret) throw new Error("KIOSK_SECRET is not configured");
  return secret;
}

export const createKioskToken = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      orgId: string;
      label: string;
      view: KioskView;
      expiresInDays: number | null; // null = permanent
    }) => data
  )
  .handler(async ({ data }) => {
    const userId = await assertKioskTokenPermission(data.orgId);

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
      view: data.view,
      iat: Math.floor(Date.now() / 1000),
      ...(exp ? { exp } : {}),
    };

    const token = await signToken(payload, getKioskSecret());

    const kioskToken = await prisma.kioskToken.create({
      data: {
        orgId: data.orgId,
        label: data.label,
        view: data.view,
        token,
        expiresAt: exp ? new Date(exp * 1000) : null,
        createdBy: userId,
      },
    });

    return kioskToken;
  });

export const listKioskTokens = createServerFn({ method: "GET" })
  .inputValidator((data: { orgId: string }) => data)
  .handler(async ({ data }) => {
    await assertKioskTokenPermission(data.orgId);
    const prisma = getPrisma();
    return await prisma.kioskToken.findMany({
      where: { orgId: data.orgId, revokedAt: null },
      orderBy: { createdAt: "desc" },
    });
  });

export const revokeKioskToken = createServerFn({ method: "POST" })
  .inputValidator((data: { tokenId: string }) => data)
  .handler(async ({ data }) => {
    const prisma = getPrisma();
    const existing = await prisma.kioskToken.findUnique({
      where: { id: data.tokenId },
      select: { orgId: true },
    });
    if (!existing) throw new Error("Token not found");
    await assertKioskTokenPermission(existing.orgId);
    return await prisma.kioskToken.update({
      where: { id: data.tokenId },
      data: { revokedAt: new Date() },
    });
  });

export const validateKioskToken = createServerFn({ method: "GET" })
  .inputValidator((data: string) => data)
  .handler(async ({ data }) => {
    // First verify the JWT signature + expiration
    const payload = await verifyToken(data, getKioskSecret());
    if (!payload) return null;

    // Then check it hasn't been revoked in the database
    const prisma = getPrisma();
    const kioskToken = await prisma.kioskToken.findUnique({
      where: { token: data },
      select: { revokedAt: true, view: true, orgId: true },
    });
    if (!kioskToken || kioskToken.revokedAt) return null;

    return {
      orgId: payload.orgId as string,
      orgSlug: payload.orgSlug as string,
      view: payload.view as string,
    };
  });
