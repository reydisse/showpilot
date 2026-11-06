-- Background credential migration stores only a numeric scan checkpoint.
-- Per-value compare-and-set updates never overwrite concurrent credential edits.
CREATE TABLE credential_backfill_cursor (
  name TEXT NOT NULL PRIMARY KEY,
  lastRowId INTEGER NOT NULL DEFAULT 0 CHECK (lastRowId >= 0)
);
