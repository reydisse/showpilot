ALTER TABLE device ADD COLUMN latencyMs INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(latencyMs) = 'integer' AND latencyMs >= 0 AND latencyMs <= 60000);
