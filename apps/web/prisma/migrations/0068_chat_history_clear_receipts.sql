CREATE TABLE chat_history_clear_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  confirmName TEXT NOT NULL,
  claimId TEXT NOT NULL,
  cutoff INTEGER NOT NULL,
  rooms TEXT NOT NULL,
  PRIMARY KEY (orgId, actorId, requestId)
);
