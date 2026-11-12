-- One immutable replacement outcome, committed with the show rows and timer.
CREATE TABLE rundown_replacement_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  actorId TEXT NOT NULL,
  showId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','cancelled','conflict','removed')),
  revision INTEGER,
  PRIMARY KEY(orgId,requestId)
);
