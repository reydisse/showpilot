-- Service-level venue shown on crew invitations and calendar events.
-- Additive and safe for existing rundowns; blank means not yet specified.
ALTER TABLE "rundown" ADD COLUMN "location" TEXT NOT NULL DEFAULT '';
