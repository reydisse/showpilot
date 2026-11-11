CREATE TABLE notification_timezone_revision (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  PRIMARY KEY(orgId,userId)
);

INSERT INTO notification_timezone_revision(orgId,userId,revision)
SELECT s.orgId,u.id,1 FROM app_setting s JOIN user u ON s.key='notification-timezone:' || u.id;

-- Track the existing preference in place, including writes from an older build.
-- Keeping the revision after deletion prevents an old read from becoming valid again.
CREATE TRIGGER notification_timezone_insert AFTER INSERT ON app_setting
WHEN substr(NEW.key,1,22)='notification-timezone:'
  AND EXISTS(SELECT 1 FROM user WHERE id=substr(NEW.key,23))
BEGIN
  INSERT INTO notification_timezone_revision(orgId,userId,revision) VALUES(NEW.orgId,substr(NEW.key,23),1)
  ON CONFLICT(orgId,userId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER notification_timezone_update AFTER UPDATE OF value ON app_setting
WHEN substr(NEW.key,1,22)='notification-timezone:'
  AND EXISTS(SELECT 1 FROM user WHERE id=substr(NEW.key,23))
BEGIN
  INSERT INTO notification_timezone_revision(orgId,userId,revision) VALUES(NEW.orgId,substr(NEW.key,23),1)
  ON CONFLICT(orgId,userId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER notification_timezone_delete AFTER DELETE ON app_setting
WHEN substr(OLD.key,1,22)='notification-timezone:'
  AND EXISTS(SELECT 1 FROM user WHERE id=substr(OLD.key,23))
  AND EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId)
BEGIN
  INSERT INTO notification_timezone_revision(orgId,userId,revision) VALUES(OLD.orgId,substr(OLD.key,23),1)
  ON CONFLICT(orgId,userId) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE notification_timezone_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claimId TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict')),
  revision INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(orgId,userId,requestId)
);
