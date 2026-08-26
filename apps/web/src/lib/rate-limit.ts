import { env } from "cloudflare:workers";

// D1 atomic insert-and-count rate limiting (table: rate_limit_event, migration
// 0006). Cloudflare WAF rules layer on top in production. Fails open: a
// rate-limit storage error must never take down the endpoint it protects.

export interface RateLimitDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      run(): Promise<{ success: boolean; meta: { changes: number } }>;
    };
  };
}

export async function isRateLimited(
  bucket: string,
  opts: { max: number; windowSeconds: number },
  dependencies: { db?: RateLimitDatabase } = {},
): Promise<boolean> {
  const db: RateLimitDatabase = dependencies.db ?? env.DB;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - opts.windowSeconds;
  try {
    const result = await db
      .prepare(
        `INSERT INTO rate_limit_event (id, bucket, createdAt)
         SELECT ?, ?, ?
         WHERE (
           SELECT COUNT(*) FROM rate_limit_event
           WHERE bucket = ? AND createdAt > ?
         ) < ?`,
      )
      .bind(crypto.randomUUID(), bucket, now, bucket, windowStart, opts.max)
      .run();
    if (!result.success) throw new Error("Rate-limit insert failed");
    const limited = result.meta.changes !== 1;

    // Opportunistic cleanup of expired rows for this bucket.
    try {
      await db
        .prepare("DELETE FROM rate_limit_event WHERE bucket = ? AND createdAt <= ?")
        .bind(bucket, windowStart)
        .run();
    } catch {
      console.error("[rate-limit] expired-event cleanup failed");
    }
    return limited;
  } catch (err) {
    console.error("[rate-limit] check failed, allowing request:", err);
    return false;
  }
}

/** Client IP as seen by Cloudflare (empty string when unavailable, e.g. local dev). */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "";
}
