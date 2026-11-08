-- Public-link receipts are scoped to the access record, never to a raw token.
CREATE TABLE crew_assignment_response (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  accessId TEXT NOT NULL REFERENCES crew_schedule_access(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  assignmentId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict','closed','unavailable','cancelled')),
  appliedRevision TEXT,
  notification TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,accessId,requestId)
);
