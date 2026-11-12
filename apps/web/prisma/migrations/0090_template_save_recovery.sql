-- Template requests survive lost responses and cancellation before delivery.
CREATE TABLE template_save_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  actorId TEXT NOT NULL,
  showId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','cancelled','conflict','removed')),
  nonce TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(orgId,requestId)
);
