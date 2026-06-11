-- Billing columns on organization (launch spec Tasks 2.1 + 2.7).
-- Effective plan precedence (beta > trial > plan) lives in
-- src/lib/plan-limits.ts — these columns are the raw inputs.
ALTER TABLE "organization" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'free';
ALTER TABLE "organization" ADD COLUMN "stripeCustomerId" TEXT;
ALTER TABLE "organization" ADD COLUMN "stripeSubscriptionId" TEXT;
ALTER TABLE "organization" ADD COLUMN "subscriptionStatus" TEXT;
ALTER TABLE "organization" ADD COLUMN "trialEndsAt" DATETIME;
ALTER TABLE "organization" ADD COLUMN "foundingMember" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "organization" ADD COLUMN "betaTester" BOOLEAN NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS "organization_stripeCustomerId_key" ON "organization"("stripeCustomerId");

-- Platform-level (cross-org) settings, e.g. publicLaunchDate.
-- app_setting is org-scoped with an orgId FK, so platform flags get
-- their own table.
CREATE TABLE IF NOT EXISTS "platform_setting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_setting_key_key" ON "platform_setting"("key");
