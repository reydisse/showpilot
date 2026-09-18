-- Better Auth's database-backed limiter survives Worker isolate restarts.
-- The key is unique so concurrent requests update one bucket atomically.
CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL,
  "lastRequest" INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "rateLimit_key_key"
ON "rateLimit"("key");
