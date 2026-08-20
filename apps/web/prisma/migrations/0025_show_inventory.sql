CREATE TABLE IF NOT EXISTS "show_inventory_item" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "location" TEXT NOT NULL DEFAULT '',
  "defaultStartTime" TEXT,
  "rundownJson" TEXT NOT NULL DEFAULT '[]',
  "sourceTemplateId" TEXT,
  "archivedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "show_inventory_item_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "show_inventory_item_orgId_archivedAt_name_idx"
  ON "show_inventory_item" ("orgId", "archivedAt", "name");
