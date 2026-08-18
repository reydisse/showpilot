-- Threaded incident discussion, reusable reactions, and separate crew responses.
ALTER TABLE "incident_comment" ADD COLUMN "parentId" TEXT REFERENCES "incident_comment"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "incident_comment_parentId_createdAt_idx"
ON "incident_comment"("parentId", "createdAt");

CREATE TABLE IF NOT EXISTS "content_reaction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authorName" TEXT NOT NULL,
  "emoji" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "content_reaction_target_user_emoji_key"
ON "content_reaction"("orgId", "targetType", "targetId", "userId", "emoji");
CREATE INDEX IF NOT EXISTS "content_reaction_target_idx"
ON "content_reaction"("orgId", "targetType", "targetId");

ALTER TABLE "service_assignment" ADD COLUMN "responseNote" TEXT NOT NULL DEFAULT '';

-- Existing decline reasons were stored in notes. Preserve them as crew responses
-- while leaving the original text visible until a manager edits instructions.
UPDATE "service_assignment"
SET "responseNote" = "notes"
WHERE "status" = 'declined' AND trim("notes") <> '';
