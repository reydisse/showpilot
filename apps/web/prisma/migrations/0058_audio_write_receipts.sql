-- Retain receipts after assignment removal so retries never recreate a channel.
CREATE TABLE audio_write_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  assignmentId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT audio_write_precondition CHECK(precondition = 1),
  PRIMARY KEY (orgId, actorId, requestId)
);
