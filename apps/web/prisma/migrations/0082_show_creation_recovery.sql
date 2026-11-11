-- The receipt survives show deletion so retrying cannot recreate that show.
-- The show, its initial items and this receipt commit in the same D1 batch.
CREATE TABLE show_creation_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  serviceDate TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,requestId)
);
