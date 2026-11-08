-- Keep results after show deletion. An exact retry must never recreate or
-- overwrite a show, even after later edits or relay command-ID eviction.
CREATE TABLE show_details_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  showId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict','cancelled','removed')),
  metadata TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,requestId)
);
