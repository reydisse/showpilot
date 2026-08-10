-- Crew scheduling and incident lifecycle.
--
-- Two gaps the production dashboard could not fill without schema:
--
--   1. CrewMember is a roster, not a schedule. There was no way to say
--      "Sam is on Camera 2 this Sunday", so the dashboard could only
--      report who happened to be checked in, and only at call time.
--      service_assignment is that missing join: one row per position on
--      one service, with an optional crew member (null = still open) and
--      a confirmation state.
--
--   2. Incident had no lifecycle. Every incident belonged to a single
--      serviceDate and was never closed, so nothing carried forward.
--      An open incident from last Sunday is the single most useful thing
--      a PM can see on a planning day.
--
-- Both are additive. Existing incidents default to 'open', which is the
-- correct reading of a row that was never resolvable.

CREATE TABLE IF NOT EXISTS "service_assignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "serviceDate" TEXT NOT NULL,
    "crewMemberId" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "notes" TEXT NOT NULL DEFAULT '',
    "invitedAt" DATETIME,
    "respondedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_assignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "service_assignment_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "crew_member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "service_assignment_orgId_serviceDate_idx" ON "service_assignment"("orgId", "serviceDate");
CREATE INDEX IF NOT EXISTS "service_assignment_crewMemberId_idx" ON "service_assignment"("crewMemberId");

-- Incident lifecycle. NOT idempotent — check pragma_table_info('incident')
-- and drop any line whose column already exists.

ALTER TABLE "incident" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'open';
ALTER TABLE "incident" ADD COLUMN "resolvedAt" DATETIME;
ALTER TABLE "incident" ADD COLUMN "resolvedBy" TEXT;

CREATE INDEX IF NOT EXISTS "incident_orgId_status_idx" ON "incident"("orgId", "status");
