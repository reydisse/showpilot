-- Normalize existing mixed Prisma/SQLite timestamp text. Application writers
-- use canonical UTC ISO-8601; readers still compare parsed instants for safety.
UPDATE "notification"
SET "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', datetime("createdAt"))
WHERE datetime("createdAt") IS NOT NULL;

UPDATE "notification"
SET "readAt" = strftime('%Y-%m-%dT%H:%M:%fZ', datetime("readAt"))
WHERE "readAt" IS NOT NULL AND datetime("readAt") IS NOT NULL;
