-- Cloud lower thirds default ON for NEW orgs (SHOWPILOT-FIXES-SPEC Task A1).
--
-- The organization.cloud_enabled column already exists (added earlier); this
-- migration only flips its column DEFAULT from 0 to 1. SQLite cannot ALTER a
-- column default in place, so the canonical table-rebuild is used.
--
-- ADDITIVE / NON-DESTRUCTIVE: every column and every existing row value is
-- copied verbatim by naming all columns in the INSERT...SELECT, so existing
-- orgs keep whatever value they already had (owners flip via the new toggle).
-- The new DEFAULT 1 only affects future inserts that omit the column.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "cloud_enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL,
    "metadata" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "subscriptionStatus" TEXT,
    "trialEndsAt" DATETIME,
    "foundingMember" BOOLEAN NOT NULL DEFAULT 0,
    "betaTester" BOOLEAN NOT NULL DEFAULT 0
);

INSERT INTO "new_organization" (
    "id", "name", "slug", "logo", "cloud_enabled", "createdAt", "metadata",
    "plan", "stripeCustomerId", "stripeSubscriptionId", "subscriptionStatus",
    "trialEndsAt", "foundingMember", "betaTester"
)
SELECT
    "id", "name", "slug", "logo", "cloud_enabled", "createdAt", "metadata",
    "plan", "stripeCustomerId", "stripeSubscriptionId", "subscriptionStatus",
    "trialEndsAt", "foundingMember", "betaTester"
FROM "organization";

DROP TABLE "organization";
ALTER TABLE "new_organization" RENAME TO "organization";

CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");
CREATE UNIQUE INDEX "organization_stripeCustomerId_key" ON "organization"("stripeCustomerId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
