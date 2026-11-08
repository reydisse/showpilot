-- A completed row is the durable receipt for this stable show identity.
-- Preparation blocks new writes before relays are checked or retired.
CREATE TABLE show_deletion (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  showId TEXT NOT NULL,
  serviceDate TEXT NOT NULL,
  nonce TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('preparing','purging','deleted')),
  actorId TEXT REFERENCES user(id) ON DELETE SET NULL,
  createdAt INTEGER NOT NULL,
  completedAt INTEGER,
  PRIMARY KEY(orgId,showId)
);

CREATE TRIGGER rundown_show_deletion_insert BEFORE INSERT ON rundown
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.id))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER rundown_show_deletion_update BEFORE UPDATE ON rundown
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.id) OR (d.orgId=OLD.orgId AND d.showId=OLD.id))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER rundown_item_show_deletion_insert BEFORE INSERT ON rundown_item
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER rundown_item_show_deletion_update BEFORE UPDATE ON rundown_item
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId) OR (d.orgId=OLD.orgId AND d.showId=OLD.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER service_assignment_show_deletion_insert BEFORE INSERT ON service_assignment
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER service_assignment_show_deletion_update BEFORE UPDATE ON service_assignment
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId) OR (d.orgId=OLD.orgId AND d.showId=OLD.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER cue_note_show_deletion_insert BEFORE INSERT ON cue_note
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER cue_note_show_deletion_update BEFORE UPDATE ON cue_note
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId) OR (d.orgId=OLD.orgId AND d.showId=OLD.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER cue_sheet_show_deletion_insert BEFORE INSERT ON cue_sheet
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER cue_sheet_show_deletion_update BEFORE UPDATE ON cue_sheet
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId) OR (d.orgId=OLD.orgId AND d.showId=OLD.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER checklist_entry_show_deletion_insert BEFORE INSERT ON checklist_entry
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER checklist_entry_show_deletion_update BEFORE UPDATE ON checklist_entry
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId) OR (d.orgId=OLD.orgId AND d.showId=OLD.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER incident_show_deletion_insert BEFORE INSERT ON incident
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER incident_show_deletion_update BEFORE UPDATE ON incident
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId) OR (d.orgId=OLD.orgId AND d.showId=OLD.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER mic_assignment_show_deletion_insert BEFORE INSERT ON mic_assignment
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER mic_assignment_show_deletion_update BEFORE UPDATE ON mic_assignment
WHEN EXISTS(SELECT 1 FROM show_deletion d WHERE (d.orgId=NEW.orgId AND d.showId=NEW.showId) OR (d.orgId=OLD.orgId AND d.showId=OLD.showId))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;


-- Older direct snapshot writers must not recreate output after relay retirement.
CREATE TRIGGER app_setting_show_deletion_insert BEFORE INSERT ON app_setting
WHEN (substr(NEW.key,1,instr(NEW.key,':')-1) IN ('rundown-items','rundown-timer','rundown-message','rundown-ppslide','rundown-items-storage') AND EXISTS(SELECT 1 FROM show_deletion d WHERE d.orgId=NEW.orgId AND d.showId=substr(NEW.key,instr(NEW.key,':')+1)))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

CREATE TRIGGER app_setting_show_deletion_update BEFORE UPDATE ON app_setting
WHEN (substr(NEW.key,1,instr(NEW.key,':')-1) IN ('rundown-items','rundown-timer','rundown-message','rundown-ppslide','rundown-items-storage') AND EXISTS(SELECT 1 FROM show_deletion d WHERE d.orgId=NEW.orgId AND d.showId=substr(NEW.key,instr(NEW.key,':')+1))) OR (substr(OLD.key,1,instr(OLD.key,':')-1) IN ('rundown-items','rundown-timer','rundown-message','rundown-ppslide','rundown-items-storage') AND EXISTS(SELECT 1 FROM show_deletion d WHERE d.orgId=OLD.orgId AND d.showId=substr(OLD.key,instr(OLD.key,':')+1)))
BEGIN
  SELECT RAISE(ABORT,'This show is being deleted or has been deleted');
END;

