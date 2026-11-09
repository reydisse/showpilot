-- All incident writers and preference writers invalidate reviewed changes.
-- Tombstones prevent a deleted/recreated identifier from reviving an old command.
CREATE TABLE incident_management_revision (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 incidentId TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(orgId,incidentId)
);
INSERT INTO incident_management_revision(orgId,incidentId,revision) SELECT orgId,id,1 FROM incident;
CREATE TRIGGER incident_management_revision_insert AFTER INSERT ON incident BEGIN
 INSERT INTO incident_management_revision(orgId,incidentId,revision) VALUES(NEW.orgId,NEW.id,1)
 ON CONFLICT(orgId,incidentId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER incident_management_revision_update AFTER UPDATE ON incident BEGIN
 INSERT INTO incident_management_revision(orgId,incidentId,revision) VALUES(NEW.orgId,NEW.id,1)
 ON CONFLICT(orgId,incidentId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER incident_management_revision_delete AFTER DELETE ON incident
WHEN EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId) BEGIN
 INSERT INTO incident_management_revision(orgId,incidentId,revision) VALUES(OLD.orgId,OLD.id,1)
 ON CONFLICT(orgId,incidentId) DO UPDATE SET revision=revision+1;
END;
CREATE TABLE dashboard_layout_revision (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 dashboard TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(orgId,userId,dashboard)
);
INSERT INTO dashboard_layout_revision(orgId,userId,dashboard,revision) SELECT orgId,userId,dashboard,1 FROM dashboard_layout;
CREATE TRIGGER dashboard_layout_revision_insert AFTER INSERT ON dashboard_layout BEGIN
 INSERT INTO dashboard_layout_revision(orgId,userId,dashboard,revision) VALUES(NEW.orgId,NEW.userId,NEW.dashboard,1)
 ON CONFLICT(orgId,userId,dashboard) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER dashboard_layout_revision_update AFTER UPDATE ON dashboard_layout BEGIN
 INSERT INTO dashboard_layout_revision(orgId,userId,dashboard,revision) VALUES(NEW.orgId,NEW.userId,NEW.dashboard,1)
 ON CONFLICT(orgId,userId,dashboard) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER dashboard_layout_revision_delete AFTER DELETE ON dashboard_layout
WHEN EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId) AND EXISTS(SELECT 1 FROM user WHERE id=OLD.userId) BEGIN
 INSERT INTO dashboard_layout_revision(orgId,userId,dashboard,revision) VALUES(OLD.orgId,OLD.userId,OLD.dashboard,1)
 ON CONFLICT(orgId,userId,dashboard) DO UPDATE SET revision=revision+1;
END;
CREATE TABLE tm_management_request (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 requestId TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 nonce TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict','cancelled','expired')),
 incidentId TEXT,
 appliedRevision INTEGER,
 notification TEXT,
 notificationStatus TEXT NOT NULL DEFAULT 'none' CHECK(notificationStatus IN ('none','pending','delivered','skipped')),
 PRIMARY KEY(orgId,actorId,requestId)
);
CREATE INDEX tm_management_pending_notifications ON tm_management_request(orgId,actorId,notificationStatus);
