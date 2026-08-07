-- Repair drift between prisma/schema.prisma and the numbered migrations.
--
-- Four models in schema.prisma were never given a CREATE TABLE, and three
-- columns were never added. Prisma generates a client for the schema, so
-- typechecking passes and the code compiles — the failure only appears at
-- runtime when a query hits a table or column D1 does not have.
--
-- Affected code paths:
--   org_member        -> middleware/withPermission.ts, routes/$slug/team.tsx
--   rundown           -> scheduled start time + live status (rundown.ts).
--                        Reads are wrapped in .catch(() => null), so this
--                        degrades silently: start times were never stored.
--   rundown_item      -> relational rundown store; falls back to AppSetting
--                        JSON, so actualStart/actualEnd never persist.
--   waitlist_signup   -> routes/api/waitlist, lib/superadmin.ts
--   stream_destination.cfOutputId / liveInputId -> Stream Connect simulcast
--   chat_message.senderRole -> ChatRelay, chat.ts
--
-- The CREATE TABLE statements are IF NOT EXISTS and safe to re-run.
-- SQLite has no ADD COLUMN IF NOT EXISTS, so the ALTER block at the bottom
-- is NOT idempotent — check pragma_table_info first and drop any line for a
-- column that already exists. See DEPLOY.md.

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

-- ─── Missing columns (NOT idempotent — see header) ───────────
--
-- Some databases already have org_member / rundown_item / waitlist_signup
-- from an earlier `prisma db push`, in which case the CREATE TABLE blocks
-- above are skipped and these tables can still be missing columns. Check
-- each one first:
--
--   SELECT name FROM pragma_table_info('rundown_item');
--   SELECT name FROM pragma_table_info('stream_destination');
--   SELECT name FROM pragma_table_info('chat_message');
--
-- and delete any line below whose column already exists.

ALTER TABLE "rundown_item" ADD COLUMN "scheduledStart" DATETIME;
ALTER TABLE "rundown_item" ADD COLUMN "expectedEnd" DATETIME;
ALTER TABLE "rundown_item" ADD COLUMN "actualStart" DATETIME;
ALTER TABLE "rundown_item" ADD COLUMN "actualEnd" DATETIME;

ALTER TABLE "stream_destination" ADD COLUMN "cfOutputId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "stream_destination" ADD COLUMN "liveInputId" TEXT NOT NULL DEFAULT '';

ALTER TABLE "chat_message" ADD COLUMN "senderRole" TEXT;
