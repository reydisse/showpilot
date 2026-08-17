-- Explicit scheduler lanes replace unreliable role-name inference.
-- Existing assignments remain visible under Production.
ALTER TABLE "service_assignment" ADD COLUMN "department" TEXT NOT NULL DEFAULT 'Production';
