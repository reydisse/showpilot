-- Keep acknowledgement and notification intent after the grant disappears.
CREATE TABLE access_write_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  grantId TEXT NOT NULL,
  targetId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('grant','revoke')),
  notificationId TEXT NOT NULL UNIQUE,
  notificationPayload TEXT NOT NULL,
  notificationState TEXT NOT NULL DEFAULT 'pending'
    CHECK(notificationState IN ('pending','created','superseded')),
  createdAt INTEGER NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT access_write_precondition CHECK(precondition=1),
  PRIMARY KEY(orgId,actorId,requestId)
);
CREATE INDEX access_write_pending_idx ON access_write_receipt(orgId,actorId,notificationState,createdAt);
