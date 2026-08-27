-- Better Auth 1.7 scopes every external account identity by its trusted issuer.
-- ShowPilot currently enables only email/password credentials, whose canonical
-- identity is (local:credential, linked user ID). Refuse the migration if a
-- provider outside that reviewed inventory exists or one user has duplicate
-- credential accounts; those rows require an explicit provider-owned backfill.
--
-- Production read-only preflight (must return 0, 0 before applying):
-- SELECT COUNT(*) FROM account WHERE providerId <> 'credential';
-- SELECT COUNT(*) FROM (
--   SELECT userId FROM account WHERE providerId = 'credential'
--   GROUP BY userId HAVING COUNT(*) > 1
-- );
CREATE TABLE "_account_issuer_migration_guard" (
  "valid" INTEGER NOT NULL CHECK ("valid" = 1)
);

INSERT INTO "_account_issuer_migration_guard" ("valid")
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM "account" WHERE "providerId" <> 'credential') THEN 0
  WHEN EXISTS (
    SELECT 1 FROM "account"
    WHERE "providerId" = 'credential'
    GROUP BY "userId"
    HAVING COUNT(*) > 1
  ) THEN 0
  ELSE 1
END;

DROP TABLE "_account_issuer_migration_guard";

CREATE TABLE "account_better_auth_1_7" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "issuer" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATETIME,
  "refreshTokenExpiresAt" DATETIME,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "account_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "account_better_auth_1_7" (
  "id", "issuer", "accountId", "providerId", "userId", "accessToken",
  "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt",
  "scope", "password", "createdAt", "updatedAt"
)
SELECT
  "id", 'local:credential', "userId", "providerId", "userId", "accessToken",
  "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt",
  "scope", "password", "createdAt", "updatedAt"
FROM "account";

DROP TABLE "account";
ALTER TABLE "account_better_auth_1_7" RENAME TO "account";

CREATE INDEX "account_userId_idx" ON "account"("userId");
CREATE UNIQUE INDEX "account_issuer_accountId_uidx"
  ON "account"("issuer", "accountId");
