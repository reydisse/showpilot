CREATE TABLE schedule_invitation_delivery (
  id TEXT PRIMARY KEY NOT NULL,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  assignmentId TEXT NOT NULL REFERENCES service_assignment(id) ON DELETE CASCADE,
  crewMemberId TEXT NOT NULL REFERENCES crew_member(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  accessId TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','sending','accepted','failed','uncertain')),
  inAppDelivered INTEGER NOT NULL DEFAULT 0 CHECK(inAppDelivered IN (0,1)),
  firstSentAt INTEGER,
  leaseNonce TEXT,
  leaseUntil INTEGER,
  updatedAt INTEGER NOT NULL,
  UNIQUE(orgId,assignmentId,requestId)
);
CREATE INDEX schedule_invitation_delivery_scope ON schedule_invitation_delivery(orgId,assignmentId,updatedAt);
CREATE TABLE schedule_reminder_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  selection TEXT NOT NULL,
  targets TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,actorId,requestId)
);
