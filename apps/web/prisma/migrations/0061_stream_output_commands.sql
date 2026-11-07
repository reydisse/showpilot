-- Physical state survives superseding commands and destination deletion.
-- Commands contain no RTMP credentials. credentialClaim is a keyed digest.
CREATE TABLE stream_output_command (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  targets TEXT NOT NULL CHECK(json_valid(targets)),
  completed TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(completed)),
  configurations TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(configurations)),
  createdAt INTEGER NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT stream_output_precondition CHECK(precondition=1),
  UNIQUE(orgId,actorId,requestId)
);
CREATE TABLE stream_output_intent (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  destinationId TEXT NOT NULL,
  commandId TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('live','stop','disable','delete','select')),
  desiredInputId TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(json_valid(state)),
  credentialClaim TEXT,
  leaseId TEXT NOT NULL DEFAULT '',
  leaseUntil INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(orgId,destinationId),
  UNIQUE(orgId,credentialClaim)
);
CREATE INDEX stream_output_command_org_created ON stream_output_command(orgId,createdAt);
