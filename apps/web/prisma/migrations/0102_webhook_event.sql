CREATE TABLE webhook_event (
  id TEXT PRIMARY KEY NOT NULL,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX webhook_event_org_order ON webhook_event(orgId, timestamp DESC, seq DESC);
INSERT INTO webhook_event(id, orgId, timestamp, seq, payload)
SELECT 'legacy-webhook-' || a.id || '-' || j.key, a.orgId,
  CASE WHEN j.type = 'object' THEN COALESCE(json_extract(j.value, '$.timestamp'), '') ELSE '' END,
  -CAST(j.key AS INTEGER),
  CASE j.type WHEN 'text' THEN json_quote(j.value) WHEN 'null' THEN 'null'
    WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE CAST(j.value AS TEXT) END
FROM app_setting a, json_each(CASE WHEN json_valid(a.value) THEN
  CASE WHEN json_type(a.value) = 'array' THEN a.value ELSE '[]' END ELSE '[]' END) j
WHERE a.key = 'webhook-events';
DELETE FROM app_setting WHERE key = 'webhook-events';
