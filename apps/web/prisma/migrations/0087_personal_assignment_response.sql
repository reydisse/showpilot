-- Response receipts survive assignment removal so retry can recover its outcome.
CREATE TABLE personal_assignment_response (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  assignmentId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict','closed','unavailable','cancelled')),
  appliedRevision TEXT,
  notification TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,actorId,requestId)
);
