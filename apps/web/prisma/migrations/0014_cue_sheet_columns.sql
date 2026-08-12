-- Cue sheet, rebuilt around the rundown.
--
-- The old CueSheet model stored its own `rundownItem` string, so the
-- running order had to be typed twice — once in the rundown, once here —
-- and the two drifted the moment anything moved. Rows now come from
-- rundown_item; this migration only adds the per-department note cells
-- that hang off them.
--
-- cue_sheet is deliberately left in place and untouched. Nothing reads
-- it after this change, but dropping a table with real production data
-- in it is not something a migration should do quietly.

-- ─── cue_column ──────────────────────────────────────────────
--
-- A department column: Production, Pro Ops, LX, Sound, SC, SM. Org-owned
-- because every church names these differently.

CREATE TABLE IF NOT EXISTS "cue_column" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'slate',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 160,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cue_column_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "cue_column_orgId_sortOrder_idx" ON "cue_column"("orgId", "sortOrder");

-- ─── cue_note ────────────────────────────────────────────────
--
-- One cell. Keyed by the rundown item's stable itemId, so reordering the
-- rundown moves the notes with it and deleting an item orphans nothing
-- the reader can see.
--
-- The unique index is what makes an upsert-per-keystroke-blur safe: two
-- operators editing the same cell converge on one row instead of
-- silently creating two.

CREATE TABLE IF NOT EXISTS "cue_note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "serviceDate" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "cue_note_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "cue_column" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "cue_note_orgId_serviceDate_itemId_columnId_key" ON "cue_note"("orgId", "serviceDate", "itemId", "columnId");
CREATE INDEX IF NOT EXISTS "cue_note_orgId_serviceDate_idx" ON "cue_note"("orgId", "serviceDate");
