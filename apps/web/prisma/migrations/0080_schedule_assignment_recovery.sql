-- Keep tombstones so deleting and recreating an id cannot revive an old edit.
CREATE TABLE schedule_assignment_revision (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  assignmentId TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY(orgId, assignmentId)
);
INSERT INTO schedule_assignment_revision
SELECT orgId,id,lower(hex(randomblob(16))) FROM service_assignment;

CREATE TRIGGER schedule_assignment_revision_insert AFTER INSERT ON service_assignment
BEGIN
  INSERT INTO schedule_assignment_revision VALUES(NEW.orgId,NEW.id,lower(hex(randomblob(16))))
  ON CONFLICT(orgId,assignmentId) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER schedule_assignment_revision_update AFTER UPDATE ON service_assignment
WHEN OLD.showId IS NOT NEW.showId OR OLD.serviceDate IS NOT NEW.serviceDate
  OR OLD.crewMemberId IS NOT NEW.crewMemberId OR OLD.role IS NOT NEW.role
  OR OLD.department IS NOT NEW.department OR OLD.status IS NOT NEW.status
  OR OLD.callTime IS NOT NEW.callTime OR OLD.notes IS NOT NEW.notes
  OR OLD.responseNote IS NOT NEW.responseNote OR OLD.respondedAt IS NOT NEW.respondedAt
  OR OLD.assignedByUserId IS NOT NEW.assignedByUserId
BEGIN
  UPDATE schedule_assignment_revision SET revision=lower(hex(randomblob(16)))
  WHERE orgId=NEW.orgId AND assignmentId=NEW.id;
END;
CREATE TRIGGER schedule_assignment_revision_delete AFTER DELETE ON service_assignment
WHEN EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId)
BEGIN
  INSERT INTO schedule_assignment_revision VALUES(OLD.orgId,OLD.id,lower(hex(randomblob(16))))
  ON CONFLICT(orgId,assignmentId) DO UPDATE SET revision=excluded.revision;
END;

CREATE TABLE schedule_assignment_request (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  nonce TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict')),
  assignmentId TEXT NOT NULL,
  revision TEXT,
  invitation TEXT,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY(orgId,actorId,requestId)
);
