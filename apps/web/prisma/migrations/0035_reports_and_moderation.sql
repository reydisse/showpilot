-- Structured, optional post-show notes. One person can contribute one note
-- per show; PM and TM notes remain separate because they answer different
-- operational questions.
CREATE TABLE IF NOT EXISTS "show_report_note" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "orgId"       TEXT NOT NULL,
    "showId"      TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "authorName"  TEXT NOT NULL,
    "role"        TEXT NOT NULL,
    "summary"     TEXT NOT NULL DEFAULT '',
    "wins"        TEXT NOT NULL DEFAULT '',
    "issues"      TEXT NOT NULL DEFAULT '',
    "followUps"   TEXT NOT NULL DEFAULT '',
    "createdAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "show_report_note_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "show_report_note_showId_fkey"
      FOREIGN KEY ("showId") REFERENCES "rundown" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "show_report_note_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "show_report_note_author_key"
  ON "show_report_note" ("orgId", "showId", "userId");
CREATE INDEX IF NOT EXISTS "show_report_note_show_idx"
  ON "show_report_note" ("orgId", "showId", "updatedAt");

-- Makes the five-minute reminder job idempotent.
CREATE TABLE IF NOT EXISTS "show_report_reminder" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "orgId"     TEXT NOT NULL,
    "showId"    TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "show_report_reminder_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "show_report_reminder_showId_fkey"
      FOREIGN KEY ("showId") REFERENCES "rundown" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "show_report_reminder_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "show_report_reminder_recipient_key"
  ON "show_report_reminder" ("orgId", "showId", "userId");

-- App Review Guideline 1.2 requires user-generated-content products to let
-- people report content and block abusive users.
CREATE TABLE IF NOT EXISTS "content_block" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "orgId"         TEXT NOT NULL,
    "blockerUserId" TEXT NOT NULL,
    "blockedUserId" TEXT NOT NULL,
    "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "content_block_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "content_block_blockerUserId_fkey"
      FOREIGN KEY ("blockerUserId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "content_block_blockedUserId_fkey"
      FOREIGN KEY ("blockedUserId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "content_block_not_self" CHECK ("blockerUserId" <> "blockedUserId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "content_block_pair_key"
  ON "content_block" ("orgId", "blockerUserId", "blockedUserId");
CREATE INDEX IF NOT EXISTS "content_block_viewer_idx"
  ON "content_block" ("orgId", "blockerUserId");

CREATE TABLE IF NOT EXISTS "content_report" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "orgId"          TEXT NOT NULL,
    "reporterUserId" TEXT NOT NULL,
    "targetType"     TEXT NOT NULL,
    "targetId"       TEXT NOT NULL,
    "targetAuthorId" TEXT,
    "reason"         TEXT NOT NULL,
    "details"        TEXT NOT NULL DEFAULT '',
    "status"         TEXT NOT NULL DEFAULT 'open',
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt"     DATETIME,
    "reviewedBy"     TEXT,
    CONSTRAINT "content_report_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "content_report_reporterUserId_fkey"
      FOREIGN KEY ("reporterUserId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "content_report_targetAuthorId_fkey"
      FOREIGN KEY ("targetAuthorId") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "content_report_reviewedBy_fkey"
      FOREIGN KEY ("reviewedBy") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "content_report_target_type_check" CHECK ("targetType" IN ('chat-message', 'incident-comment')),
    CONSTRAINT "content_report_reason_check" CHECK ("reason" IN ('harassment', 'hate', 'sexual', 'violence', 'spam', 'other')),
    CONSTRAINT "content_report_status_check" CHECK ("status" IN ('open', 'reviewing', 'resolved', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS "content_report_queue_idx"
  ON "content_report" ("orgId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "content_report_target_idx"
  ON "content_report" ("orgId", "targetType", "targetId");
