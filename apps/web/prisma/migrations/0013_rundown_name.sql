-- Name a service.
--
-- Rundown carried a date, a start time and a status but no title, so
-- "Christmas Eve 7pm" and "Youth Night" were indistinguishable from any
-- other Tuesday — every list could only show a date.
--
-- Deliberately on Rundown rather than a new table: Rundown is already
-- unique per (orgId, serviceDate), so today it IS the service record.
-- When multi-service lands (see SHOWPILOT-MULTISERVICE-SPEC.md) this
-- column moves to Service with the rest of the row.
--
-- NOT idempotent — check pragma_table_info('rundown') first.

ALTER TABLE "rundown" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
