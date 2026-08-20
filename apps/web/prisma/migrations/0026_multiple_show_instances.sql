-- Introduce stable show-instance identity while retaining serviceDate for
-- display, calendar grouping, and backwards-compatible reporting.
--
-- Rundown already represents one scheduled show, so its primary key becomes
-- the canonical showId. Operational records are backfilled to that ID before
-- same-date uniqueness is removed in a later enabling migration. The new
-- columns are nullable during the application rollout; every migrated row is
-- populated here and new write paths will require showId before the UI enables
-- multiple same-date shows.

-- Ensure older date-scoped operational data has a parent show to reference.
-- D1 intentionally limits the number of terms in a compound SELECT. Keep the
-- backfill as separate statements so this migration works in both D1 and
-- stock SQLite. The existing rundown date uniqueness makes each statement
-- safe, while DISTINCT prevents duplicate source rows within a statement.
INSERT INTO "rundown" (
  "id", "orgId", "serviceDate", "name", "scheduledStartTime", "location",
  "status", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), dates."orgId", dates."serviceDate", '', NULL, '',
  'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "orgId", "serviceDate" FROM "rundown_item") AS dates
WHERE NOT EXISTS (
  SELECT 1 FROM "rundown" existing
  WHERE existing."orgId" = dates."orgId"
    AND existing."serviceDate" = dates."serviceDate"
);

INSERT INTO "rundown" (
  "id", "orgId", "serviceDate", "name", "scheduledStartTime", "location",
  "status", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), dates."orgId", dates."serviceDate", '', NULL, '',
  'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "orgId", "serviceDate" FROM "service_assignment") AS dates
WHERE NOT EXISTS (
  SELECT 1 FROM "rundown" existing
  WHERE existing."orgId" = dates."orgId"
    AND existing."serviceDate" = dates."serviceDate"
);

INSERT INTO "rundown" (
  "id", "orgId", "serviceDate", "name", "scheduledStartTime", "location",
  "status", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), dates."orgId", dates."serviceDate", '', NULL, '',
  'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "orgId", "serviceDate" FROM "checklist_entry") AS dates
WHERE NOT EXISTS (
  SELECT 1 FROM "rundown" existing
  WHERE existing."orgId" = dates."orgId"
    AND existing."serviceDate" = dates."serviceDate"
);

INSERT INTO "rundown" (
  "id", "orgId", "serviceDate", "name", "scheduledStartTime", "location",
  "status", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), dates."orgId", dates."serviceDate", '', NULL, '',
  'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "orgId", "serviceDate" FROM "cue_sheet") AS dates
WHERE NOT EXISTS (
  SELECT 1 FROM "rundown" existing
  WHERE existing."orgId" = dates."orgId"
    AND existing."serviceDate" = dates."serviceDate"
);

INSERT INTO "rundown" (
  "id", "orgId", "serviceDate", "name", "scheduledStartTime", "location",
  "status", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), dates."orgId", dates."serviceDate", '', NULL, '',
  'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "orgId", "serviceDate" FROM "cue_note") AS dates
WHERE NOT EXISTS (
  SELECT 1 FROM "rundown" existing
  WHERE existing."orgId" = dates."orgId"
    AND existing."serviceDate" = dates."serviceDate"
);

INSERT INTO "rundown" (
  "id", "orgId", "serviceDate", "name", "scheduledStartTime", "location",
  "status", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), dates."orgId", dates."serviceDate", '', NULL, '',
  'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "orgId", "serviceDate" FROM "incident") AS dates
WHERE NOT EXISTS (
  SELECT 1 FROM "rundown" existing
  WHERE existing."orgId" = dates."orgId"
    AND existing."serviceDate" = dates."serviceDate"
);

INSERT INTO "rundown" (
  "id", "orgId", "serviceDate", "name", "scheduledStartTime", "location",
  "status", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), dates."orgId", dates."serviceDate", '', NULL, '',
  'stopped', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "orgId", "serviceDate" FROM "mic_assignment") AS dates
WHERE NOT EXISTS (
  SELECT 1 FROM "rundown" existing
  WHERE existing."orgId" = dates."orgId"
    AND existing."serviceDate" = dates."serviceDate"
);

ALTER TABLE "rundown_item" ADD COLUMN "showId" TEXT
  REFERENCES "rundown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_assignment" ADD COLUMN "showId" TEXT
  REFERENCES "rundown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "checklist_entry" ADD COLUMN "showId" TEXT
  REFERENCES "rundown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cue_sheet" ADD COLUMN "showId" TEXT
  REFERENCES "rundown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cue_note" ADD COLUMN "showId" TEXT
  REFERENCES "rundown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "incident" ADD COLUMN "showId" TEXT
  REFERENCES "rundown"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mic_assignment" ADD COLUMN "showId" TEXT
  REFERENCES "rundown"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "rundown_item"
SET "showId" = (
  SELECT "id" FROM "rundown"
  WHERE "rundown"."orgId" = "rundown_item"."orgId"
    AND "rundown"."serviceDate" = "rundown_item"."serviceDate"
  LIMIT 1
);
UPDATE "service_assignment"
SET "showId" = (
  SELECT "id" FROM "rundown"
  WHERE "rundown"."orgId" = "service_assignment"."orgId"
    AND "rundown"."serviceDate" = "service_assignment"."serviceDate"
  LIMIT 1
);
UPDATE "checklist_entry"
SET "showId" = (
  SELECT "id" FROM "rundown"
  WHERE "rundown"."orgId" = "checklist_entry"."orgId"
    AND "rundown"."serviceDate" = "checklist_entry"."serviceDate"
  LIMIT 1
);
UPDATE "cue_sheet"
SET "showId" = (
  SELECT "id" FROM "rundown"
  WHERE "rundown"."orgId" = "cue_sheet"."orgId"
    AND "rundown"."serviceDate" = "cue_sheet"."serviceDate"
  LIMIT 1
);
UPDATE "cue_note"
SET "showId" = (
  SELECT "id" FROM "rundown"
  WHERE "rundown"."orgId" = "cue_note"."orgId"
    AND "rundown"."serviceDate" = "cue_note"."serviceDate"
  LIMIT 1
);
UPDATE "incident"
SET "showId" = (
  SELECT "id" FROM "rundown"
  WHERE "rundown"."orgId" = "incident"."orgId"
    AND "rundown"."serviceDate" = "incident"."serviceDate"
  LIMIT 1
);
UPDATE "mic_assignment"
SET "showId" = (
  SELECT "id" FROM "rundown"
  WHERE "rundown"."orgId" = "mic_assignment"."orgId"
    AND "rundown"."serviceDate" = "mic_assignment"."serviceDate"
  LIMIT 1
);

CREATE UNIQUE INDEX "rundown_item_orgId_showId_itemId_key"
  ON "rundown_item"("orgId", "showId", "itemId");
CREATE UNIQUE INDEX "cue_note_orgId_showId_itemId_columnId_key"
  ON "cue_note"("orgId", "showId", "itemId", "columnId");

CREATE INDEX "rundown_orgId_serviceDate_scheduledStartTime_idx"
  ON "rundown"("orgId", "serviceDate", "scheduledStartTime");
CREATE INDEX "rundown_item_orgId_showId_sortOrder_idx"
  ON "rundown_item"("orgId", "showId", "sortOrder");
CREATE INDEX "service_assignment_orgId_showId_idx"
  ON "service_assignment"("orgId", "showId");
CREATE INDEX "checklist_entry_orgId_showId_idx"
  ON "checklist_entry"("orgId", "showId");
CREATE INDEX "cue_sheet_orgId_showId_idx"
  ON "cue_sheet"("orgId", "showId");
CREATE INDEX "cue_note_orgId_showId_idx"
  ON "cue_note"("orgId", "showId");
CREATE INDEX "incident_orgId_showId_idx"
  ON "incident"("orgId", "showId");
CREATE INDEX "mic_assignment_orgId_showId_idx"
  ON "mic_assignment"("orgId", "showId");
