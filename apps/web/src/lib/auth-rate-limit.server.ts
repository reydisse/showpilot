interface RateLimitDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

interface RateLimitRow {
  count: number;
  lastRequest: number;
}

export function createD1RateLimitStorage(database: RateLimitDatabase) {
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const now = Date.now();
      const resetBefore = now - rule.window * 1_000;
      const row = await database.prepare(
        `INSERT INTO rateLimit (id, key, count, lastRequest)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE
             WHEN rateLimit.lastRequest <= ? THEN 1
             ELSE rateLimit.count + 1
           END,
           lastRequest = CASE
             WHEN rateLimit.lastRequest <= ? THEN excluded.lastRequest
             ELSE rateLimit.lastRequest
           END
         RETURNING count, lastRequest`,
      ).bind(key, key, now, resetBefore, resetBefore).first<RateLimitRow>();

      if (!row) {
        // A storage failure must fail closed instead of silently removing
        // credential-stuffing protection.
        return { allowed: false, retryAfter: rule.window };
      }

      const allowed = row.count <= rule.max;
      const retryAfter = allowed
        ? null
        : Math.max(1, Math.ceil((row.lastRequest + rule.window * 1_000 - now) / 1_000));

      // Keep the durable table bounded without adding work to every request.
      if (Math.random() < 0.01) {
        try {
          await database.prepare(
            "DELETE FROM rateLimit WHERE lastRequest < ? AND key <> ?",
          ).bind(now - 86_400_000, key).run();
        } catch {
          // Cleanup is opportunistic and must not reject an otherwise valid
          // authentication request.
        }
      }

      return { allowed, retryAfter };
    },
  };
}
