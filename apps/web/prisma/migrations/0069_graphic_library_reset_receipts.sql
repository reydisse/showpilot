CREATE TABLE graphic_library_reset_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  confirmName TEXT NOT NULL,
  claimId TEXT NOT NULL,
  deletedCount INTEGER NOT NULL,
  PRIMARY KEY (orgId, actorId, requestId)
);
