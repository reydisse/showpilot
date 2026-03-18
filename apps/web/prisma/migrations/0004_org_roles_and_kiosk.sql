-- Organization roles table (Better Auth dynamic access control)
-- Table name must be "organizationRole" to match Better Auth's expected mapping
CREATE TABLE IF NOT EXISTS "organizationRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME,
    CONSTRAINT "organizationRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "organizationRole_organizationId_idx" ON "organizationRole"("organizationId");
CREATE INDEX IF NOT EXISTS "organizationRole_role_idx" ON "organizationRole"("role");

-- Kiosk tokens table (JWT-based public display access)
CREATE TABLE IF NOT EXISTS "kiosk_token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "view" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "createdBy" TEXT NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "kiosk_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "kiosk_token_token_key" ON "kiosk_token"("token");
CREATE INDEX IF NOT EXISTS "kiosk_token_orgId_idx" ON "kiosk_token"("orgId");
CREATE INDEX IF NOT EXISTS "kiosk_token_token_idx" ON "kiosk_token"("token");
