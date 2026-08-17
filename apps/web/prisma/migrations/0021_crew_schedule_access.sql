CREATE TABLE IF NOT EXISTS crew_schedule_access (
  id TEXT PRIMARY KEY NOT NULL,
  orgId TEXT NOT NULL,
  crewMemberId TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastUsedAt TEXT,
  revokedAt TEXT,
  FOREIGN KEY (orgId) REFERENCES organization(id) ON DELETE CASCADE,
  FOREIGN KEY (crewMemberId) REFERENCES crew_member(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS crew_schedule_access_org_crew_idx
  ON crew_schedule_access(orgId, crewMemberId);
CREATE INDEX IF NOT EXISTS crew_schedule_access_expiry_idx
  ON crew_schedule_access(expiresAt);
