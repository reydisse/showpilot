-- A review can claim an undelivered request before a late write reaches D1.
-- Existing receipts acknowledge already-applied commands.
ALTER TABLE crew_write_receipt ADD COLUMN outcome TEXT NOT NULL DEFAULT 'applied'
  CHECK(outcome IN ('applied','cancelled'));
