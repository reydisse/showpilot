CREATE TABLE destination_control_revision (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 destinationId TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(orgId,destinationId)
);
INSERT INTO destination_control_revision(orgId,destinationId,revision)
 SELECT orgId,id,1 FROM stream_destination;
CREATE TRIGGER destination_control_insert AFTER INSERT ON stream_destination BEGIN
 INSERT INTO destination_control_revision(orgId,destinationId,revision) VALUES(NEW.orgId,NEW.id,1)
 ON CONFLICT(orgId,destinationId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER destination_control_update AFTER UPDATE ON stream_destination BEGIN
 INSERT INTO destination_control_revision(orgId,destinationId,revision) VALUES(NEW.orgId,NEW.id,1)
 ON CONFLICT(orgId,destinationId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER destination_control_delete AFTER DELETE ON stream_destination
WHEN EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId) BEGIN
 INSERT INTO destination_control_revision(orgId,destinationId,revision) VALUES(OLD.orgId,OLD.id,1)
 ON CONFLICT(orgId,destinationId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER destination_control_intent_insert AFTER INSERT ON stream_output_intent BEGIN
 INSERT INTO destination_control_revision(orgId,destinationId,revision) VALUES(NEW.orgId,NEW.destinationId,1)
 ON CONFLICT(orgId,destinationId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER destination_control_intent_update AFTER UPDATE OF commandId ON stream_output_intent
WHEN OLD.commandId<>NEW.commandId BEGIN
 INSERT INTO destination_control_revision(orgId,destinationId,revision) VALUES(NEW.orgId,NEW.destinationId,1)
 ON CONFLICT(orgId,destinationId) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER destination_control_intent_delete AFTER DELETE ON stream_output_intent
WHEN EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId) BEGIN
 INSERT INTO destination_control_revision(orgId,destinationId,revision) VALUES(OLD.orgId,OLD.destinationId,1)
 ON CONFLICT(orgId,destinationId) DO UPDATE SET revision=revision+1;
END;
CREATE TABLE destination_control_request (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 requestId TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','applied','conflict','cancelled','expired','superseded')),
 destinationId TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(orgId,actorId,requestId)
);
