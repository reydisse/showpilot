-- Recover the same signed grant after an uncertain response without extending it.
-- Payload holds claims, never the bearer signature or signing secret.
CREATE TABLE chat_pass_creation_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (orgId, actorId, requestId)
);
