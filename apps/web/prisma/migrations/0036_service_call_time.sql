-- A show may override the organization-wide crew-call lead with an explicit
-- venue-local call time. NULL preserves the derived default for existing shows.
ALTER TABLE "rundown" ADD COLUMN "scheduledCallTime" DATETIME;
