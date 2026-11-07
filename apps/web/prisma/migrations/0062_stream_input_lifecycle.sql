CREATE TABLE stream_input_command (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL,
  requestId TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('create','delete')),
  name TEXT NOT NULL,
  inputId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
  createdAt INTEGER NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT stream_input_precondition CHECK(precondition=1),
  UNIQUE(orgId,actorId,requestId)
);
CREATE TABLE stream_input_lifecycle (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  inputId TEXT NOT NULL,
  creationId TEXT NOT NULL DEFAULT '',
  deletionId TEXT NOT NULL DEFAULT '',
  desired TEXT NOT NULL CHECK(desired IN ('active','deleted')),
  phase TEXT NOT NULL CHECK(phase IN ('prepared','creating','identified','stored','ready','deleted')),
  providerId TEXT NOT NULL DEFAULT '',
  leaseId TEXT NOT NULL DEFAULT '',
  leaseUntil INTEGER NOT NULL DEFAULT 0,
  lastActorId TEXT NOT NULL,
  PRIMARY KEY(orgId,inputId)
);
CREATE TABLE stream_input_health (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  inputId TEXT NOT NULL REFERENCES live_input(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  checkedAt TEXT,
  PRIMARY KEY(orgId,inputId)
);
