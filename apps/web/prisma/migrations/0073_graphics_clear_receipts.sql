CREATE TABLE graphics_output_revision (
 orgId TEXT PRIMARY KEY NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0
);
-- Every writer advances the pointer revision, including Companion and old
-- clients. Re-selecting the same graphic cannot make an old Clear current again.
CREATE TRIGGER graphics_output_insert AFTER INSERT ON app_setting
WHEN NEW.key IN ('active-graphics','active-graphic','active-lower-third')
BEGIN
 INSERT INTO graphics_output_revision(orgId,revision) VALUES(NEW.orgId,1)
 ON CONFLICT(orgId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER graphics_output_update AFTER UPDATE OF value ON app_setting
WHEN NEW.key IN ('active-graphics','active-graphic','active-lower-third')
BEGIN
 INSERT INTO graphics_output_revision(orgId,revision) VALUES(NEW.orgId,1)
 ON CONFLICT(orgId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER graphics_output_delete AFTER DELETE ON app_setting
WHEN OLD.key IN ('active-graphics','active-graphic','active-lower-third')
 AND EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId)
BEGIN
 INSERT INTO graphics_output_revision(orgId,revision) VALUES(OLD.orgId,1)
 ON CONFLICT(orgId) DO UPDATE SET revision=revision+1;
END;

-- Editing/removing an on-air template changes the reviewed content too.
CREATE TRIGGER graphics_live_template_insert AFTER INSERT ON graphic_template
WHEN EXISTS(SELECT 1 FROM organization WHERE id=NEW.orgId)
 AND EXISTS(SELECT 1 FROM app_setting s WHERE s.orgId=NEW.orgId AND (
  (s.key='active-graphic' AND s.value=NEW.id) OR
  (s.key='active-graphics' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(s.value) AND json_type(s.value)='array' THEN s.value ELSE '[]' END) WHERE value=NEW.id))
 ))
BEGIN
 INSERT INTO graphics_output_revision(orgId,revision) VALUES(NEW.orgId,1)
 ON CONFLICT(orgId) DO UPDATE SET revision=revision+1;
END;

-- Editing/removing an on-air template changes the reviewed content too.
CREATE TRIGGER graphics_live_template_update AFTER UPDATE ON graphic_template
WHEN EXISTS(SELECT 1 FROM organization WHERE id=NEW.orgId)
 AND EXISTS(SELECT 1 FROM app_setting s WHERE s.orgId=NEW.orgId AND (
  (s.key='active-graphic' AND s.value=NEW.id) OR
  (s.key='active-graphics' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(s.value) AND json_type(s.value)='array' THEN s.value ELSE '[]' END) WHERE value=NEW.id))
 ))
BEGIN
 INSERT INTO graphics_output_revision(orgId,revision) VALUES(NEW.orgId,1)
 ON CONFLICT(orgId) DO UPDATE SET revision=revision+1;
END;

-- Editing/removing an on-air template changes the reviewed content too.
CREATE TRIGGER graphics_live_template_delete AFTER DELETE ON graphic_template
WHEN EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId)
 AND EXISTS(SELECT 1 FROM app_setting s WHERE s.orgId=OLD.orgId AND (
  (s.key='active-graphic' AND s.value=OLD.id) OR
  (s.key='active-graphics' AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(s.value) AND json_type(s.value)='array' THEN s.value ELSE '[]' END) WHERE value=OLD.id))
 ))
BEGIN
 INSERT INTO graphics_output_revision(orgId,revision) VALUES(OLD.orgId,1)
 ON CONFLICT(orgId) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE graphics_clear_receipt (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 requestId TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 claimId TEXT NOT NULL,
 programOutcome TEXT NOT NULL CHECK(programOutcome IN ('applied','conflict','expired')),
 relayOutcome TEXT CHECK(relayOutcome IN ('applied','conflict','expired','skipped')),
 createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(orgId,actorId,requestId)
);
