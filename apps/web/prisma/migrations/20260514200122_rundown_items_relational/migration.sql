-- CreateTable
CREATE TABLE "org_member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    CONSTRAINT "org_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "org_member_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "rundown_item" (
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
    "hardStop" BOOLEAN NOT NULL DEFAULT false,
    "lowerThirdId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "rundown_item_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "kiosk_token" (
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

-- CreateTable
CREATE TABLE "waitlist_signup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "orgName" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "organizationRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME,
    CONSTRAINT "organizationRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "cloud_enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL,
    "metadata" TEXT
);
INSERT INTO "new_organization" ("createdAt", "id", "logo", "metadata", "name", "slug") SELECT "createdAt", "id", "logo", "metadata", "name", "slug" FROM "organization";
DROP TABLE "organization";
ALTER TABLE "new_organization" RENAME TO "organization";
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "org_member_orgId_idx" ON "org_member"("orgId");

-- CreateIndex
CREATE INDEX "org_member_userId_idx" ON "org_member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "org_member_userId_orgId_key" ON "org_member"("userId", "orgId");

-- CreateIndex
CREATE INDEX "rundown_item_orgId_serviceDate_sortOrder_idx" ON "rundown_item"("orgId", "serviceDate", "sortOrder");

-- CreateIndex
CREATE INDEX "rundown_item_orgId_serviceDate_idx" ON "rundown_item"("orgId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "rundown_item_orgId_serviceDate_itemId_key" ON "rundown_item"("orgId", "serviceDate", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "kiosk_token_token_key" ON "kiosk_token"("token");

-- CreateIndex
CREATE INDEX "kiosk_token_orgId_idx" ON "kiosk_token"("orgId");

-- CreateIndex
CREATE INDEX "kiosk_token_token_idx" ON "kiosk_token"("token");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_signup_email_key" ON "waitlist_signup"("email");

-- CreateIndex
CREATE INDEX "organizationRole_organizationId_idx" ON "organizationRole"("organizationId");

-- CreateIndex
CREATE INDEX "organizationRole_role_idx" ON "organizationRole"("role");
