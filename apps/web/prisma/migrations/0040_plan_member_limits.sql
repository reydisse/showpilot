-- Enforce organization member capacity at the shared database boundary so
-- Better Auth's direct routes and concurrent requests cannot bypass app code.
-- Pending invitations reserve capacity; accepting one releases its invitation
-- slot before inserting the member, keeping the total stable.

CREATE TRIGGER "organization_member_limit_on_invitation_insert"
BEFORE INSERT ON "invitation"
WHEN NEW."status" = 'pending'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM "member" WHERE "organizationId" = NEW."organizationId") +
    (SELECT COUNT(*) FROM "invitation" WHERE "organizationId" = NEW."organizationId" AND "status" = 'pending')
  ) >= (
    SELECT CASE
      WHEN o."betaTester" = 1 AND (
        (SELECT "value" FROM "platform_setting" WHERE "key" = 'publicLaunchDate' LIMIT 1) IS NULL OR
        datetime((SELECT "value" FROM "platform_setting" WHERE "key" = 'publicLaunchDate' LIMIT 1)) > CURRENT_TIMESTAMP
      ) THEN 100
      WHEN o."trialEndsAt" IS NOT NULL AND datetime(o."trialEndsAt") > CURRENT_TIMESTAMP THEN 100
      WHEN o."plan" = 'pro' AND (o."subscriptionStatus" IS NULL OR o."subscriptionStatus" IN ('active', 'trialing', 'past_due')) THEN 100
      WHEN o."plan" = 'starter' AND (o."subscriptionStatus" IS NULL OR o."subscriptionStatus" IN ('active', 'trialing', 'past_due')) THEN 25
      ELSE 5
    END
    FROM "organization" o WHERE o."id" = NEW."organizationId"
  ) THEN RAISE(ABORT, 'organization member limit reached') END;
END;

CREATE TRIGGER "organization_member_limit_on_invitation_reopen"
BEFORE UPDATE OF "status" ON "invitation"
WHEN NEW."status" = 'pending' AND OLD."status" <> 'pending'
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM "member" WHERE "organizationId" = NEW."organizationId") +
    (SELECT COUNT(*) FROM "invitation" WHERE "organizationId" = NEW."organizationId" AND "status" = 'pending' AND "id" <> OLD."id")
  ) >= (
    SELECT CASE
      WHEN o."betaTester" = 1 AND (
        (SELECT "value" FROM "platform_setting" WHERE "key" = 'publicLaunchDate' LIMIT 1) IS NULL OR
        datetime((SELECT "value" FROM "platform_setting" WHERE "key" = 'publicLaunchDate' LIMIT 1)) > CURRENT_TIMESTAMP
      ) THEN 100
      WHEN o."trialEndsAt" IS NOT NULL AND datetime(o."trialEndsAt") > CURRENT_TIMESTAMP THEN 100
      WHEN o."plan" = 'pro' AND (o."subscriptionStatus" IS NULL OR o."subscriptionStatus" IN ('active', 'trialing', 'past_due')) THEN 100
      WHEN o."plan" = 'starter' AND (o."subscriptionStatus" IS NULL OR o."subscriptionStatus" IN ('active', 'trialing', 'past_due')) THEN 25
      ELSE 5
    END
    FROM "organization" o WHERE o."id" = NEW."organizationId"
  ) THEN RAISE(ABORT, 'organization member limit reached') END;
END;

CREATE TRIGGER "organization_member_limit_on_member_insert"
BEFORE INSERT ON "member"
BEGIN
  SELECT CASE WHEN (
    (SELECT COUNT(*) FROM "member" WHERE "organizationId" = NEW."organizationId") +
    (SELECT COUNT(*) FROM "invitation" WHERE "organizationId" = NEW."organizationId" AND "status" = 'pending')
  ) >= (
    SELECT CASE
      WHEN o."betaTester" = 1 AND (
        (SELECT "value" FROM "platform_setting" WHERE "key" = 'publicLaunchDate' LIMIT 1) IS NULL OR
        datetime((SELECT "value" FROM "platform_setting" WHERE "key" = 'publicLaunchDate' LIMIT 1)) > CURRENT_TIMESTAMP
      ) THEN 100
      WHEN o."trialEndsAt" IS NOT NULL AND datetime(o."trialEndsAt") > CURRENT_TIMESTAMP THEN 100
      WHEN o."plan" = 'pro' AND (o."subscriptionStatus" IS NULL OR o."subscriptionStatus" IN ('active', 'trialing', 'past_due')) THEN 100
      WHEN o."plan" = 'starter' AND (o."subscriptionStatus" IS NULL OR o."subscriptionStatus" IN ('active', 'trialing', 'past_due')) THEN 25
      ELSE 5
    END
    FROM "organization" o WHERE o."id" = NEW."organizationId"
  ) THEN RAISE(ABORT, 'organization member limit reached') END;
END;
