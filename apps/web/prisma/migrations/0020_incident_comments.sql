-- Persistent follow-up discussion for incidents, including after resolution.
CREATE TABLE IF NOT EXISTS "incident_comment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authorName" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_comment_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incident" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "incident_comment_orgId_incidentId_createdAt_idx" ON "incident_comment"("orgId", "incidentId", "createdAt");
