-- Expo accepts a push message before APNs or FCM reports the final result.
-- Keep ticket IDs long enough for the scheduled Worker to check those receipts
-- and remove device tokens that the platform reports as unregistered.
CREATE TABLE IF NOT EXISTS "expo_push_receipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ticketId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "nextCheckAt" DATETIME NOT NULL,
  CONSTRAINT "expo_push_receipt_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "push_subscription" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "expo_push_receipt_ticketId_key"
ON "expo_push_receipt"("ticketId");

CREATE INDEX IF NOT EXISTS "expo_push_receipt_nextCheckAt_idx"
ON "expo_push_receipt"("nextCheckAt");
