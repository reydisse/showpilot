-- One reusable checklist template may appear only once in a show. This makes
-- retries and concurrent operators converge on the same service entry.
--
-- The production preflight must report zero duplicate groups before applying:
-- SELECT COUNT(*) FROM (
--   SELECT 1 FROM checklist_entry WHERE showId IS NOT NULL
--   GROUP BY orgId, showId, templateId HAVING COUNT(*) > 1
-- );
CREATE UNIQUE INDEX "checklist_entry_orgId_showId_templateId_key"
  ON "checklist_entry"("orgId", "showId", "templateId");
