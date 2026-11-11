-- A copy keeps its original source rows even if either roster changes later.
CREATE TABLE schedule_copy_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  reason TEXT,
  rows TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,actorId,requestId)
);
