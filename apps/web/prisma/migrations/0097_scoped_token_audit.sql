-- Deliberately excludes token values, labels, and payloads.
CREATE TABLE scoped_token_audit (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL,
  tokenId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('kiosk','companion')),
  action TEXT NOT NULL CHECK (action IN ('created','revoked')),
  actorUserId TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX scoped_token_audit_org_time ON scoped_token_audit(orgId, createdAt);
CREATE INDEX scoped_token_audit_token_time ON scoped_token_audit(tokenId, createdAt);
