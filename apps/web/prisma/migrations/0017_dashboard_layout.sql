-- Personal dashboard layouts follow a manager across devices. The JSON is
-- versioned by the application and never trusted without validation.
CREATE TABLE "dashboard_layout" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "dashboard" TEXT NOT NULL,
  "layout" TEXT NOT NULL,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dashboard_layout_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "dashboard_layout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "dashboard_layout_orgId_userId_dashboard_key" ON "dashboard_layout"("orgId", "userId", "dashboard");
