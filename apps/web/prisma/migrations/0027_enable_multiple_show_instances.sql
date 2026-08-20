-- Enable more than one show on the same calendar date now that operational
-- rows and realtime rooms have stable show IDs.
DROP INDEX IF EXISTS "rundown_orgId_serviceDate_key";
DROP INDEX IF EXISTS "rundown_item_orgId_serviceDate_itemId_key";
DROP INDEX IF EXISTS "cue_note_orgId_serviceDate_itemId_columnId_key";
