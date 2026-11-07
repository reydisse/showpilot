-- One recipient decision owns the membership/session transaction. Retain the
-- original membership ID so replay cannot restore a later removed membership.
CREATE TABLE invitation_response (
  invitationId TEXT PRIMARY KEY REFERENCES invitation(id) ON DELETE CASCADE,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actorId TEXT REFERENCES user(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected')),
  nonce TEXT NOT NULL,
  memberId TEXT,
  respondedAt TEXT NOT NULL
);
