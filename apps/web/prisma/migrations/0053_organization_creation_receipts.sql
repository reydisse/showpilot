-- Keep a user's creation receipt after organization deletion so retries cannot
-- resurrect it. Account deletion removes the receipt with the user.
CREATE TABLE organization_creation_receipt (
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  orgId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  createdAt DATETIME NOT NULL,
  PRIMARY KEY (userId, requestId)
);
CREATE UNIQUE INDEX organization_creation_receipt_org ON organization_creation_receipt(orgId);
