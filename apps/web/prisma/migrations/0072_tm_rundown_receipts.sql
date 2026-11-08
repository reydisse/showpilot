CREATE TABLE tm_rundown_command_receipt (
 orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 requestId TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 relayBody TEXT NOT NULL,
 outcome TEXT CHECK(outcome IN ('applied','revision-conflict','expired','target-changed','unavailable')),
 createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 PRIMARY KEY(orgId,actorId,requestId)
);
