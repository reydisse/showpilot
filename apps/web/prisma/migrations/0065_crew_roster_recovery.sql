ALTER TABLE crew_member ADD COLUMN profileRevision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER crew_member_profile_revision
AFTER UPDATE OF memberId,name,role,email,photoUrl,orgId ON crew_member
WHEN NEW.profileRevision <= OLD.profileRevision AND (
  NEW.memberId IS NOT OLD.memberId OR NEW.name IS NOT OLD.name OR
  NEW.role IS NOT OLD.role OR NEW.email IS NOT OLD.email OR
  NEW.photoUrl IS NOT OLD.photoUrl OR NEW.orgId IS NOT OLD.orgId
)
BEGIN
  UPDATE crew_member SET profileRevision=OLD.profileRevision+1 WHERE id=NEW.id;
END;
CREATE TABLE crew_write_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  crewId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('create','update','delete')),
  createdAt INTEGER NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT crew_write_precondition CHECK(precondition=1),
  PRIMARY KEY(orgId,actorId,requestId)
);
