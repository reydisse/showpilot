-- Retain tombstone revisions so deleting and recreating an id cannot revive a
-- previously reviewed edit. Every writer, including old native clients, counts.
CREATE TABLE graphic_template_revision (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 graphicId TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(orgId,graphicId)
);
INSERT INTO graphic_template_revision(orgId,graphicId,revision)
 SELECT orgId,id,1 FROM graphic_template;
CREATE TRIGGER graphic_template_revision_insert AFTER INSERT ON graphic_template
BEGIN
 INSERT INTO graphic_template_revision(orgId,graphicId,revision) VALUES(NEW.orgId,NEW.id,1)
 ON CONFLICT(orgId,graphicId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER graphic_template_revision_update AFTER UPDATE ON graphic_template
BEGIN
 INSERT INTO graphic_template_revision(orgId,graphicId,revision) VALUES(NEW.orgId,NEW.id,1)
 ON CONFLICT(orgId,graphicId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER graphic_template_revision_delete AFTER DELETE ON graphic_template
WHEN EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId)
BEGIN
 INSERT INTO graphic_template_revision(orgId,graphicId,revision) VALUES(OLD.orgId,OLD.id,1)
 ON CONFLICT(orgId,graphicId) DO UPDATE SET revision=revision+1;
END;
CREATE TABLE graphic_control_request (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 requestId TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 nonce TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict','cancelled','expired')),
 PRIMARY KEY(orgId,actorId,requestId)
);
