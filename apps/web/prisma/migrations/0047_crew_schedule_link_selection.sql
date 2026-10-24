-- Keep invitation selection server-side instead of exposing assignment IDs.
-- Nullable for previously delivered links, which still supply their selection.
-- Selection is a hint only; every assignment read remains scoped to org + crew.
ALTER TABLE crew_schedule_access ADD COLUMN assignmentId TEXT;
