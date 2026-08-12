-- Give a fault an owner.
--
-- Incidents recorded who reported a problem and, since 0012, whether it
-- was resolved — but never who was dealing with it. For a tech team
-- whose job is responding to faults, the two failure modes are two
-- people grabbing the same problem and nobody grabbing it at all, and
-- neither is visible without this.
--
-- `assignedName` is denormalised on purpose. The tech dashboard renders
-- a name on every fault row and re-reads every twenty seconds during a
-- service; joining out to `user` per row for a string that changes
-- roughly never is not a trade worth making. `assignedTo` remains the
-- identity — the name is a label.
--
-- acknowledgedAt is separate from assignment: claiming a fault and
-- having actually looked at it are different states, and "assigned
-- eleven minutes ago, never acknowledged" is exactly the thing a TM
-- needs to see mid-service.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS. These three columns do not
-- exist in production — verified against the schema and the local
-- database built from these migrations — so plain ALTERs are correct
-- here and will fail loudly rather than silently if that is ever wrong.

ALTER TABLE "incident" ADD COLUMN "assignedTo" TEXT;
ALTER TABLE "incident" ADD COLUMN "assignedName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "incident" ADD COLUMN "acknowledgedAt" DATETIME;

CREATE INDEX IF NOT EXISTS "incident_orgId_assignedTo_idx" ON "incident"("orgId", "assignedTo");
