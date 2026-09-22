import { env } from "cloudflare:workers";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createD1RateLimitStorage } from "@/lib/auth-rate-limit.server";

async function digestKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function enforcePublicCheckInRateLimit(
  scope: "read" | "write",
  slug: string,
  memberId: string,
): Promise<void> {
  const headers = getRequestHeaders();
  const clientAddress = headers.get("cf-connecting-ip")
    ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unidentified-client";
  const database = (env as unknown as { DB: Parameters<typeof createD1RateLimitStorage>[0] }).DB;
  const storage = createD1RateLimitStorage(database);
  const [addressKey, memberKey] = await Promise.all([
    digestKey(`${slug}:${clientAddress}`),
    digestKey(`${slug}:${memberId.toUpperCase()}`),
  ]);
  const addressRule = scope === "write" ? { window: 60, max: 30 } : { window: 60, max: 90 };
  const memberRule = scope === "write" ? { window: 60, max: 6 } : { window: 60, max: 30 };
  const addressResult = await storage.consume(`public-checkin:${scope}:address:${addressKey}`, addressRule);
  if (!addressResult.allowed) {
    throw new Error(`Too many check-in attempts. Try again in ${addressResult.retryAfter ?? addressRule.window} seconds.`);
  }
  const memberResult = await storage.consume(`public-checkin:${scope}:member:${memberKey}`, memberRule);
  if (!memberResult.allowed) {
    throw new Error(`Too many attempts for this member ID. Try again in ${memberResult.retryAfter ?? memberRule.window} seconds.`);
  }
}
