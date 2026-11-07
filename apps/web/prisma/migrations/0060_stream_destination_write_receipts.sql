-- Configuration receipts contain no stream keys or request payloads.
CREATE TABLE stream_destination_write_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  destinationId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT stream_destination_write_precondition CHECK(precondition = 1),
  PRIMARY KEY (orgId, actorId, requestId)
);
