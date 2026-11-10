CREATE TABLE operational_error (
  id TEXT PRIMARY KEY NOT NULL,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('browser', 'BridgeRelay', 'RundownRelay', 'ChatRelay')),
  code TEXT NOT NULL,
  errorName TEXT NOT NULL,
  asset TEXT,
  line INTEGER,
  column INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX operational_error_org_time ON operational_error(orgId, createdAt);
CREATE INDEX operational_error_time ON operational_error(createdAt);
