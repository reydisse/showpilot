-- Retain only a digest, never a bearer link or its recipient list.
CREATE TABLE chat_pass_revocation (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  tokenHash TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('crew-chat', 'planning-chat')),
  expiresAt INTEGER NOT NULL,
  revokedAt INTEGER NOT NULL,
  revokedBy TEXT REFERENCES user(id) ON DELETE SET NULL,
  PRIMARY KEY (orgId, tokenHash)
);
CREATE INDEX chat_pass_revocation_expiry ON chat_pass_revocation(expiresAt);
