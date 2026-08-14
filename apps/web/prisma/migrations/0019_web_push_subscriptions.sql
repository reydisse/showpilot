-- Per-device Web Push subscriptions for signed-in organization members.
-- Endpoints are capability URLs, so they are never exposed through inbox reads.
CREATE TABLE IF NOT EXISTS "push_subscription" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscription_endpoint_key"
ON "push_subscription"("endpoint");

CREATE INDEX IF NOT EXISTS "push_subscription_orgId_userId_idx"
ON "push_subscription"("orgId", "userId");
