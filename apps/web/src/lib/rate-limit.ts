import { env } from "cloudflare:workers";

// D1 insert-and-count rate limiting (table: rate_limit_event, migration
// 0006). Good enough for public endpoints like the waitlist; Cloudflare WAF
// rules layer on top in production. Fails open: a rate-limit storage error
// must never take down the endpoint it protects.

export async function isRateLimited(
  bucket: string,
  opts: { max: number; windowSeconds: number },
): Promise<boolean> {
  const db = (env as { DB: D1Database }).DB;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - opts.windowSeconds;
  try {
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS c FROM rate_limit_event WHERE bucket = ? AND createdAt > ?",
      )
      .bind(bucket, windowStart)
      .first<{ c: number }>();
    if ((row?.c ?? 0) >= opts.max) return true;

    await db
      .prepare("INSERT INTO rate_limit_event (id, bucket, createdAt) VALUES (?, ?, ?)")
      .bind(crypto.randomUUID(), bucket, now)
      .run();
    // Opportunistic cleanup of expired rows for this bucket.
    await db
      .prepare("DELETE FROM rate_limit_event WHERE bucket = ? AND createdAt <= ?")
      .bind(bucket, windowStart)
      .run();
    return false;
  } catch (err) {
    console.error("[rate-limit] check failed, allowing request:", err);
    return false;
  }
}

/** Client IP as seen by Cloudflare (empty string when unavailable, e.g. local dev). */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "";
}
