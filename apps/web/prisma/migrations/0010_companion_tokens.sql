-- 0010: Companion / Stream Deck control tokens.
-- Org-scoped `cmp_` bearer tokens for the Bitfocus Companion Generic HTTP
-- module. Mirrors kiosk_token (HMAC-signed JWT stored verbatim), but these
-- authorize WRITE control of transport/lyrics/lower-thirds/kiosk/stream — so
-- they are signed under a separate COMPANION_SECRET. No `view` column: a
-- companion token is not scoped to a single display, it drives the whole org.
CREATE TABLE IF NOT EXISTS "companion_token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "createdBy" TEXT NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "companion_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "companion_token_token_key" ON "companion_token"("token");
CREATE INDEX IF NOT EXISTS "companion_token_orgId_idx" ON "companion_token"("orgId");
CREATE INDEX IF NOT EXISTS "companion_token_token_idx" ON "companion_token"("token");
