ALTER TABLE team ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE kiosk_team_command_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claimId TEXT NOT NULL,
  teamId TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict')),
  PRIMARY KEY(orgId, actorId, requestId)
);
