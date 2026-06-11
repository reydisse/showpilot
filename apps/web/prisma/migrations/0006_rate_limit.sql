-- Rate limiting events (raw D1, not in the Prisma client — same pattern as
-- the 0005 kiosk tables). One row per counted request; callers count rows in
-- a bucket over a time window and reject when over the cap.
CREATE TABLE IF NOT EXISTS "rate_limit_event" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "bucket"    TEXT NOT NULL,   -- e.g. 'waitlist:<ip>'
    "createdAt" INTEGER NOT NULL -- unix epoch seconds
);
CREATE INDEX IF NOT EXISTS "rate_limit_event_bucket_time" ON "rate_limit_event"("bucket", "createdAt");
