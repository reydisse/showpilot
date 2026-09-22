-- Assignment responses belong to the scheduler who created or reassigned the
-- invitation. Backfill existing rows to one organization owner so legacy
-- responses still have a narrow, accountable destination.
ALTER TABLE "service_assignment" ADD COLUMN "assignedByUserId" TEXT;

UPDATE "service_assignment"
SET "assignedByUserId" = (
  SELECT "member"."userId"
  FROM "member"
  WHERE "member"."organizationId" = "service_assignment"."orgId"
    AND lower("member"."role") = 'owner'
  ORDER BY "member"."createdAt" ASC, "member"."id" ASC
  LIMIT 1
)
WHERE "assignedByUserId" IS NULL;

CREATE INDEX "service_assignment_assignedByUserId_idx"
ON "service_assignment"("assignedByUserId");
