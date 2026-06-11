-- AlterTable
ALTER TABLE "rundown_item" ADD COLUMN "actualEnd" DATETIME;
ALTER TABLE "rundown_item" ADD COLUMN "actualStart" DATETIME;
ALTER TABLE "rundown_item" ADD COLUMN "expectedEnd" DATETIME;
ALTER TABLE "rundown_item" ADD COLUMN "scheduledStart" DATETIME;

-- CreateTable
CREATE TABLE "rundown" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "serviceDate" TEXT NOT NULL,
    "scheduledStartTime" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "rundown_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "rundown_orgId_serviceDate_idx" ON "rundown"("orgId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "rundown_orgId_serviceDate_key" ON "rundown"("orgId", "serviceDate");
