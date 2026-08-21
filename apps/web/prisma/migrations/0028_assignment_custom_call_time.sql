-- Per-assignment venue call time. A wall-clock string deliberately avoids
-- shifting when a remote operator or desktop client is in another timezone.
ALTER TABLE "service_assignment" ADD COLUMN "callTime" TEXT NOT NULL DEFAULT '';
