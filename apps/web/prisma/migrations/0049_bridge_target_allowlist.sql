-- A device row or an installation key alone never approves a network destination.
CREATE TABLE bridge_target_allowlist (
  id TEXT NOT NULL PRIMARY KEY,
  orgId TEXT NOT NULL,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  protocol TEXT NOT NULL,
  approvedByUserId TEXT NOT NULL,
  approvedAt INTEGER NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organization(id) ON DELETE CASCADE,
  UNIQUE (orgId, host, port, protocol)
);
CREATE INDEX bridge_target_allowlist_org ON bridge_target_allowlist(orgId, label);

-- Only validated endpoint metadata is recorded. Never store raw messages,
-- settings, command bodies, URL paths, responses, or credential values here.
CREATE TABLE bridge_target_audit (
  id TEXT NOT NULL PRIMARY KEY,
  orgId TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approved', 'removed', 'connected', 'rejected')),
  actorUserId TEXT,
  source TEXT NOT NULL CHECK (source IN ('operator', 'automation')),
  executionId TEXT,
  host TEXT,
  port INTEGER,
  protocol TEXT,
  reason TEXT,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organization(id) ON DELETE CASCADE
);
CREATE INDEX bridge_target_audit_org_time ON bridge_target_audit(orgId, createdAt);
