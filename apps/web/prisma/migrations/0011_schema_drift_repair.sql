-- Bring the numbered migrations back in line with prisma/schema.prisma.
--
-- Four models in schema.prisma had no CREATE TABLE in any migration:
-- org_member, rundown, rundown_item and waitlist_signup. Prisma generates
-- a client from the schema, so typechecking passed and nothing surfaced
-- until a query ran against a database built from these files alone.
--
-- VERIFIED AGAINST PRODUCTION 2026-08-10.
--
-- Production already had every table and column below. It was shaped by a
-- `prisma db push` at some point, so the live database ran ahead of the
-- migration files rather than behind them — the drift was in the files,
-- not in production. Local development databases built from the numbered
-- migrations alone were the ones missing pieces.
--
-- This file is therefore a no-op against production and does the real
-- work only for a database built from migrations. Every statement is
-- IF NOT EXISTS, so it is idempotent and safe to run anywhere.
--
-- The ALTER statements this file originally carried (rundown_item timing
-- columns, stream_destination.cfOutputId / liveInputId,
-- chat_message.senderRole) have all been removed: production has them,
-- a fresh database gets them from the CREATE TABLE blocks below, and
-- SQLite has no ADD COLUMN IF NOT EXISTS so leaving them in would make
-- this file fail on the one database that matters.

-- ─── org_member ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "org_member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    CONSTRAINT "org_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "org_member_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "org_member_userId_orgId_key" ON "org_member"("userId", "orgId");
CREATE INDEX IF NOT EXISTS "org_member_orgId_idx" ON "org_member"("orgId");
CREATE INDEX IF NOT EXISTS "org_member_userId_idx" ON "org_member"("userId");

-- ─── rundown ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rundown" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "serviceDate" TEXT NOT NULL,
    "scheduledStartTime" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rundown_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "rundown_orgId_serviceDate_key" ON "rundown"("orgId", "serviceDate");
CREATE INDEX IF NOT EXISTS "rundown_orgId_serviceDate_idx" ON "rundown"("orgId", "serviceDate");

-- ─── rundown_item ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "rundown_item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "serviceDate" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "notes" TEXT NOT NULL,
    "assignee" TEXT NOT NULL,
    "cue" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "hardStop" INTEGER NOT NULL DEFAULT 0,
    "lowerThirdId" TEXT,
    "scheduledStart" DATETIME,
    "expectedEnd" DATETIME,
    "actualStart" DATETIME,
    "actualEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rundown_item_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "rundown_item_orgId_serviceDate_itemId_key" ON "rundown_item"("orgId", "serviceDate", "itemId");
CREATE INDEX IF NOT EXISTS "rundown_item_orgId_serviceDate_sortOrder_idx" ON "rundown_item"("orgId", "serviceDate", "sortOrder");
CREATE INDEX IF NOT EXISTS "rundown_item_orgId_serviceDate_idx" ON "rundown_item"("orgId", "serviceDate");

-- ─── waitlist_signup ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "waitlist_signup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "orgName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_signup_email_key" ON "waitlist_signup"("email");
