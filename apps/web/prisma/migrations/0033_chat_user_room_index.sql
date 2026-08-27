-- Account deletion must be able to find every native chat Durable Object a
-- user has participated in, even after they leave an organization.
CREATE TABLE IF NOT EXISTS "chat_user_room" (
  "userId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "orgId", "roomId")
);

CREATE INDEX IF NOT EXISTS "chat_user_room_userId_idx"
ON "chat_user_room"("userId", "updatedAt");
