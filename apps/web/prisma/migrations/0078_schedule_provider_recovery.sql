-- Preserve the existing three provider settings and track all writers in place.
INSERT INTO app_setting(id,orgId,key,value)
SELECT lower(hex(randomblob(16))),orgId,'schedule-provider-revision',lower(hex(randomblob(16)))
FROM (SELECT DISTINCT orgId FROM app_setting WHERE key IN ('schedule-provider','schedule-provider-url','schedule-provider-label'))
WHERE true ON CONFLICT(orgId,key) DO NOTHING;

CREATE TRIGGER schedule_provider_insert AFTER INSERT ON app_setting
WHEN NEW.key IN ('schedule-provider','schedule-provider-url','schedule-provider-label')
BEGIN
  INSERT INTO app_setting(id,orgId,key,value) VALUES(lower(hex(randomblob(16))),NEW.orgId,'schedule-provider-revision',lower(hex(randomblob(16))))
  ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value;
END;
CREATE TRIGGER schedule_provider_update AFTER UPDATE OF value ON app_setting
WHEN NEW.key IN ('schedule-provider','schedule-provider-url','schedule-provider-label')
BEGIN
  INSERT INTO app_setting(id,orgId,key,value) VALUES(lower(hex(randomblob(16))),NEW.orgId,'schedule-provider-revision',lower(hex(randomblob(16))))
  ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value;
END;
CREATE TRIGGER schedule_provider_delete AFTER DELETE ON app_setting
WHEN OLD.key IN ('schedule-provider','schedule-provider-url','schedule-provider-label')
  AND EXISTS(SELECT 1 FROM organization WHERE id=OLD.orgId)
BEGIN
  INSERT INTO app_setting(id,orgId,key,value) VALUES(lower(hex(randomblob(16))),OLD.orgId,'schedule-provider-revision',lower(hex(randomblob(16))))
  ON CONFLICT(orgId,key) DO UPDATE SET value=excluded.value;
END;
