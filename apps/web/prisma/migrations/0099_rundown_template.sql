CREATE TABLE rundown_template (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  templateId TEXT NOT NULL,
  name TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(orgId, templateId)
);
CREATE INDEX rundown_template_orgId_updatedAt_idx ON rundown_template(orgId, updatedAt);
CREATE TABLE rundown_template_receipt (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  templateId TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(orgId, templateId)
);

INSERT INTO rundown_template(id, orgId, templateId, name, updatedAt, payload)
SELECT id, orgId, substr(key, length('rundown-saved:') + 1),
  CASE WHEN json_valid(value) THEN COALESCE(json_extract(value, '$.name'), '') ELSE '' END,
  CASE WHEN json_valid(value) THEN COALESCE(json_extract(value, '$.updatedAt'), '') ELSE '' END,
  value
FROM app_setting WHERE key LIKE 'rundown-saved:%';
INSERT INTO rundown_template_receipt(orgId, templateId, value)
SELECT orgId, substr(key, length('rundown-template-save:') + 1), value
FROM app_setting WHERE key LIKE 'rundown-template-save:%';
DELETE FROM app_setting WHERE key LIKE 'rundown-saved:%' OR key LIKE 'rundown-template-save:%';
