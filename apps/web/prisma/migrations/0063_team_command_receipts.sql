ALTER TABLE member ADD COLUMN managementRevision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER member_management_revision AFTER UPDATE OF role ON member
WHEN NEW.role IS NOT OLD.role
BEGIN
  UPDATE member SET managementRevision=OLD.managementRevision+1 WHERE id=NEW.id AND organizationId=NEW.organizationId;
END;
CREATE TABLE team_command_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT team_command_precondition CHECK(precondition=1),
  PRIMARY KEY(orgId,actorId,requestId)
);
