ALTER TABLE "equipment" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

UPDATE "equipment"
SET "category" = LOWER("category"),
    "status" = LOWER("status");
