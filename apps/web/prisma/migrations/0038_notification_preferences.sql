-- Personal notification controls are scoped to a member and organization.
-- Missing rows keep the existing behavior so an upgrade never silences alerts.
CREATE TABLE IF NOT EXISTS "notification_preference" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "deviceAlerts" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preference_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organization" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_preference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_preference_category_check"
    CHECK ("category" IN ('schedule', 'incidents', 'chat', 'reports', 'system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preference_orgId_userId_category_key"
ON "notification_preference"("orgId", "userId", "category");

CREATE INDEX IF NOT EXISTS "notification_preference_userId_idx"
ON "notification_preference"("userId");

-- The in-app inbox is unconditional. This flag only controls interruptive
-- device/Desktop delivery for each notification record.
ALTER TABLE "notification" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'system';
ALTER TABLE "notification" ADD COLUMN "deviceAlertEnabled" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS "notification_orgId_userId_deviceAlertEnabled_createdAt_idx"
ON "notification"("orgId", "userId", "deviceAlertEnabled", "createdAt" DESC);
