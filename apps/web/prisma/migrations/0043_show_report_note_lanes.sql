-- A dual-role manager may submit one independent contribution per lane.
DROP INDEX IF EXISTS "show_report_note_author_key";
CREATE UNIQUE INDEX "show_report_note_author_lane_key"
ON "show_report_note"("orgId", "showId", "userId", "role");
