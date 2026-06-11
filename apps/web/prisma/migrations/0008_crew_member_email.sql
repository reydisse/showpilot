-- 0008: CSV people import — crew members gain an email for dedupe.
ALTER TABLE "crew_member" ADD COLUMN "email" TEXT NOT NULL DEFAULT '';
CREATE INDEX "crew_member_orgId_email_idx" ON "crew_member"("orgId", "email");
