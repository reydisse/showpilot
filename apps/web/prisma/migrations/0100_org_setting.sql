CREATE TABLE org_setting (
  orgId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (orgId, key)
);

INSERT INTO org_setting (orgId, key, value, updatedAt)
SELECT orgId, key, value, strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM app_setting WHERE key IN (
  'lyrics-output',
  'ontime-sync-rundown',
  'ontime-send-commands',
  'propresenter-pull-order',
  'default-countdown-minutes',
  'default-timer-mode',
  'timezone-display',
  'overtime-behavior',
  'default-confidence-layout',
  'l3-default-style',
  'l3-animation-speed',
  'l3-auto-clear',
  'l3-auto-clear-duration'
);
DELETE FROM app_setting WHERE key IN (
  'lyrics-output',
  'ontime-sync-rundown',
  'ontime-send-commands',
  'propresenter-pull-order',
  'default-countdown-minutes',
  'default-timer-mode',
  'timezone-display',
  'overtime-behavior',
  'default-confidence-layout',
  'l3-default-style',
  'l3-animation-speed',
  'l3-auto-clear',
  'l3-auto-clear-duration'
);
