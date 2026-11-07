-- Song command receipts and optimistic checks commit with the song writes.
-- Keep receipts after song deletion so retries cannot recreate removed songs.
ALTER TABLE song ADD COLUMN writeRevision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE song_write_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  songId TEXT NOT NULL,
  result TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT song_write_precondition CHECK(precondition = 1),
  PRIMARY KEY (orgId, actorId, requestId)
);
CREATE INDEX song_write_receipt_song ON song_write_receipt(orgId, songId);

-- Include older clients and relational writes in the revision check.
CREATE TRIGGER song_metadata_revision AFTER UPDATE OF title,artist,ccliNumber,bpm,keySignature,ppPresentationUuid,importSource ON song
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=NEW.id AND orgId=NEW.orgId;
END;

CREATE TRIGGER song_section_insert_revision AFTER INSERT ON song_section
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=NEW.songId AND orgId=NEW.orgId;
END;

CREATE TRIGGER song_section_delete_revision AFTER DELETE ON song_section
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=OLD.songId AND orgId=OLD.orgId;
END;

CREATE TRIGGER song_section_update_revision AFTER UPDATE ON song_section
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=OLD.songId AND orgId=OLD.orgId;
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=NEW.songId AND orgId=NEW.orgId
    AND (NEW.songId<>OLD.songId OR NEW.orgId<>OLD.orgId);
END;

CREATE TRIGGER song_cue_map_insert_revision AFTER INSERT ON song_cue_map
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=NEW.songId AND orgId=NEW.orgId;
END;

CREATE TRIGGER song_cue_map_delete_revision AFTER DELETE ON song_cue_map
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=OLD.songId AND orgId=OLD.orgId;
END;

CREATE TRIGGER song_cue_map_update_revision AFTER UPDATE ON song_cue_map
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=OLD.songId AND orgId=OLD.orgId;
  UPDATE song SET writeRevision=writeRevision+1 WHERE id=NEW.songId AND orgId=NEW.orgId
    AND (NEW.songId<>OLD.songId OR NEW.orgId<>OLD.orgId);
END;

CREATE TRIGGER song_cue_insert_revision AFTER INSERT ON song_cue
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE orgId=NEW.orgId
    AND id=(SELECT songId FROM song_cue_map WHERE id=NEW.cueMapId AND orgId=NEW.orgId);
END;

CREATE TRIGGER song_cue_delete_revision AFTER DELETE ON song_cue
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE orgId=OLD.orgId
    AND id=(SELECT songId FROM song_cue_map WHERE id=OLD.cueMapId AND orgId=OLD.orgId);
END;

CREATE TRIGGER song_cue_update_revision AFTER UPDATE ON song_cue
BEGIN
  UPDATE song SET writeRevision=writeRevision+1 WHERE orgId=OLD.orgId
    AND id=(SELECT songId FROM song_cue_map WHERE id=OLD.cueMapId AND orgId=OLD.orgId);
  UPDATE song SET writeRevision=writeRevision+1 WHERE orgId=NEW.orgId
    AND id=(SELECT songId FROM song_cue_map WHERE id=NEW.cueMapId AND orgId=NEW.orgId)
    AND (NEW.cueMapId<>OLD.cueMapId OR NEW.orgId<>OLD.orgId);
END;
