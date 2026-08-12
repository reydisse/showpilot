-- Personal, actionable notification inbox. Existing user:<id> targets are
-- backfilled so assignments created before this migration are not lost.
ALTER TABLE "notification" ADD COLUMN "userId" TEXT;
ALTER TABLE "notification" ADD COLUMN "actionUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "notification" ADD COLUMN "readAt" DATETIME;

UPDATE "notification"
SET "userId" = substr("target", 6), "actionUrl" = 'dashboard/tech-manager'
WHERE "target" LIKE 'user:%';

CREATE INDEX IF NOT EXISTS "notification_orgId_userId_readAt_idx"
ON "notification"("orgId", "userId", "readAt");
