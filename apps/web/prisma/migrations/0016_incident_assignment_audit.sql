-- Preserve who assigned a technical fault and when. Both columns are
-- nullable so existing incidents remain valid and rollback is unnecessary.
ALTER TABLE "incident" ADD COLUMN "assignedBy" TEXT;
ALTER TABLE "incident" ADD COLUMN "assignedAt" DATETIME;
