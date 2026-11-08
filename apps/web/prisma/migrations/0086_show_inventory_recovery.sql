-- Keep request outcomes after an inventory item is archived, restored or removed.
CREATE TABLE show_inventory_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  itemId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict','cancelled','removed')),
  appliedVersion TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,requestId)
);
