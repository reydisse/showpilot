ALTER TABLE show_report_note ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

-- Includes writes from older clients. A changed-then-restored note must not
-- make a previously unseen request with an old revision current again.
CREATE TRIGGER show_report_note_revision AFTER UPDATE OF authorName, summary, wins, issues, followUps ON show_report_note
BEGIN
  UPDATE show_report_note SET revision = OLD.revision + 1 WHERE id = NEW.id AND orgId = NEW.orgId;
END;

CREATE TABLE report_note_write_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  claimId TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','conflict')),
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(orgId,actorId,requestId)
);
