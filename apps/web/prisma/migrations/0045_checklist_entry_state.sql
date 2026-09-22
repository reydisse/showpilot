ALTER TABLE "checklist_entry" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "checklist_entry" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

UPDATE "checklist_entry"
SET "category" = COALESCE(
  (SELECT "category" FROM "checklist_template" WHERE "checklist_template"."id" = "checklist_entry"."templateId"),
  'general'
);
