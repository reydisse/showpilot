-- No configuration or credentials in receipts. Keep them after device deletion.
CREATE TABLE device_write_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  deviceId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  precondition INTEGER NOT NULL CONSTRAINT device_write_precondition CHECK(precondition = 1),
  PRIMARY KEY (orgId, actorId, requestId)
);
