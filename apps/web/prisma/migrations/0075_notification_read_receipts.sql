CREATE TABLE notification_read_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  requestId TEXT NOT NULL,
  notificationId TEXT,
  readAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (orgId, userId, requestId)
);

-- The receipt and the read set commit together. Replaying the request does not
-- mark alerts that arrived later, even when their timestamps are identical.
CREATE TRIGGER notification_read_commit AFTER INSERT ON notification_read_receipt
BEGIN
  UPDATE notification SET readAt=NEW.readAt
  WHERE orgId=NEW.orgId AND userId=NEW.userId AND dismissed=0 AND readAt IS NULL
    AND (NEW.notificationId IS NULL OR id=NEW.notificationId);
END;
