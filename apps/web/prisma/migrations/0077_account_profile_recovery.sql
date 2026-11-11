CREATE TABLE user_profile_revision (
  userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0)
);
INSERT INTO user_profile_revision(userId,revision) SELECT id,1 FROM user;
CREATE TRIGGER user_profile_insert AFTER INSERT ON user BEGIN
  INSERT INTO user_profile_revision(userId,revision) VALUES(NEW.id,1);
END;
-- Track legacy web/mobile writers too, including changing back to an old value.
CREATE TRIGGER user_profile_update AFTER UPDATE OF name,image ON user BEGIN
  INSERT INTO user_profile_revision(userId,revision) VALUES(NEW.id,1)
  ON CONFLICT(userId) DO UPDATE SET revision=revision+1;
END;
CREATE TABLE user_profile_receipt (
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claimId TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict')),
  revision INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(userId,requestId)
);
