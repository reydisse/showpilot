-- Revocable operational access for organization members. The on-duty TM may
-- issue grants only for their current roster week; owners/admins may also
-- issue grants that remain active until explicitly revoked.
CREATE TABLE IF NOT EXISTS "member_permission_grant" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "orgId"           TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "capability"      TEXT NOT NULL,
    "permissions"     TEXT NOT NULL,
    "startsOn"        TEXT NOT NULL,
    "expiresOn"       TEXT,
    "reason"          TEXT NOT NULL DEFAULT '',
    "grantedByUserId" TEXT NOT NULL,
    "revokedAt"       DATETIME,
    "revokedByUserId" TEXT,
    "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "member_permission_grant_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "member_permission_grant_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "member_permission_grant_grantedByUserId_fkey"
      FOREIGN KEY ("grantedByUserId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "member_permission_grant_revokedByUserId_fkey"
      FOREIGN KEY ("revokedByUserId") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "member_permission_grant_active_idx"
  ON "member_permission_grant" ("orgId", "userId", "startsOn", "expiresOn");
CREATE INDEX IF NOT EXISTS "member_permission_grant_revision_idx"
  ON "member_permission_grant" ("orgId", "revokedAt", "updatedAt");
CREATE INDEX IF NOT EXISTS "member_permission_grant_issuer_idx"
  ON "member_permission_grant" ("grantedByUserId");
