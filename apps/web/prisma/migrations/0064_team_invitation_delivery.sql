ALTER TABLE invitation ADD COLUMN deliveryId TEXT;
CREATE TABLE team_invitation_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  invitationId TEXT NOT NULL,
  deliveryId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT team_invitation_precondition CHECK(precondition=1),
  PRIMARY KEY(orgId,actorId,requestId)
);
CREATE TABLE team_invitation_delivery (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  invitationId TEXT NOT NULL REFERENCES invitation(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','sending','accepted','failed','uncertain')),
  leaseNonce TEXT,
  leaseUntil INTEGER,
  firstSentAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX team_invitation_delivery_scope ON team_invitation_delivery(orgId,invitationId);
