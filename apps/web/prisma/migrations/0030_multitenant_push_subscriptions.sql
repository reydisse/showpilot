-- A physical device may subscribe to more than one organization, but within
-- one organization its endpoint must belong to the currently signed-in user.
DROP INDEX IF EXISTS "push_subscription_endpoint_key";

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscription_endpoint_orgId_key"
ON "push_subscription"("endpoint", "orgId");
