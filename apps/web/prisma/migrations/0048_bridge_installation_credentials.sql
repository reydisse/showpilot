-- Bridge credentials are transport-only and stored as SHA-256 digests.
-- Installation revocation applies to every credential version, including rotation overlap.
CREATE TABLE bridge_installation (
  id TEXT NOT NULL PRIMARY KEY,
  orgId TEXT NOT NULL,
  label TEXT NOT NULL,
  createdByUserId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  lastUsedAt INTEGER,
  revokedAt INTEGER,
  FOREIGN KEY (orgId) REFERENCES organization(id) ON DELETE CASCADE,
  UNIQUE (id, orgId)
);
CREATE INDEX bridge_installation_org ON bridge_installation(orgId, createdAt);

CREATE TABLE bridge_credential (
  id TEXT NOT NULL PRIMARY KEY,
  orgId TEXT NOT NULL,
  installationId TEXT NOT NULL,
  keyHash TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER,
  FOREIGN KEY (installationId, orgId) REFERENCES bridge_installation(id, orgId) ON DELETE CASCADE,
  UNIQUE (id, orgId)
);
CREATE UNIQUE INDEX bridge_credential_org_hash ON bridge_credential(orgId, keyHash);
CREATE INDEX bridge_credential_installation ON bridge_credential(orgId, installationId, createdAt);

-- Deliberately contains no payload, URL, response, or credential value column.
CREATE TABLE bridge_credential_audit (
  id TEXT NOT NULL PRIMARY KEY,
  orgId TEXT NOT NULL,
  credentialId TEXT NOT NULL,
  action TEXT NOT NULL,
  direction TEXT NOT NULL,
  actorUserId TEXT,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (credentialId, orgId) REFERENCES bridge_credential(id, orgId) ON DELETE CASCADE
);
CREATE INDEX bridge_credential_audit_org_time ON bridge_credential_audit(orgId, createdAt);
CREATE INDEX bridge_credential_audit_key_time ON bridge_credential_audit(credentialId, createdAt);
