-- CreateTable
CREATE TABLE "graphic_template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT NOT NULL DEFAULT '',
    "style" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "graphic_template_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stream_destination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "rtmpUrl" TEXT NOT NULL DEFAULT '',
    "streamKey" TEXT NOT NULL DEFAULT '',
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stream_destination_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "live_input" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "cfInputId" TEXT NOT NULL DEFAULT '',
    "cfInputUid" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "rtmpUrl" TEXT NOT NULL DEFAULT '',
    "rtmpKey" TEXT NOT NULL DEFAULT '',
    "srtUrl" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "live_input_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "graphic_template_orgId_idx" ON "graphic_template"("orgId");

-- CreateIndex
CREATE INDEX "stream_destination_orgId_idx" ON "stream_destination"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "live_input_orgId_cfInputId_key" ON "live_input"("orgId", "cfInputId");

-- CreateIndex
CREATE INDEX "live_input_orgId_idx" ON "live_input"("orgId");
