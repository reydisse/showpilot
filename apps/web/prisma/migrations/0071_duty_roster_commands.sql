ALTER TABLE roster_role ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE duty_roster_version (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 scope TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(orgId,scope)
);
CREATE TABLE duty_roster_command_receipt (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 requestId TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 claimId TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict','role-code-taken','member-unavailable')),
 PRIMARY KEY(orgId,actorId,requestId)
);
CREATE TABLE duty_notification_job (
 id TEXT NOT NULL PRIMARY KEY,
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 assignmentId TEXT NOT NULL,
 weekStart TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('pm','tech')),
 roleId TEXT,
 roleName TEXT NOT NULL,
 removed INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','skipped')),
 createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 lastAttemptAt TEXT
);
CREATE INDEX duty_notification_pending ON duty_notification_job(status,createdAt);
