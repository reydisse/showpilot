-- 0005: Kiosk Org Chart + On-Duty Roster
-- Backs GET /api/v1/kiosk/org and GET /api/v1/kiosk/roster.
-- People reuse the existing "user" table; assets reuse "equipment".
-- Column casing follows the existing convention (camelCase columns,
-- snake_case table names), matching crew_member / kiosk_token / etc.

-- ─── Teams (org chart) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "team" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "orgId"     TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "color"     TEXT NOT NULL DEFAULT '#3b82f6',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "team_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "team_org_idx" ON "team"("orgId", "sortOrder");

CREATE TABLE IF NOT EXISTS "team_member" (
    "teamId"    TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "role"      TEXT NOT NULL DEFAULT 'member',  -- 'lead' | 'member'
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("teamId", "userId"),
    CONSTRAINT "team_member_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "team_member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "team_member_team_idx" ON "team_member"("teamId");

-- ─── On-duty roster ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "roster_role" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "orgId"     TEXT NOT NULL,
    "code"      TEXT NOT NULL,   -- 'td', 'audio', 'cam1', ... (exposed as roleId)
    "name"      TEXT NOT NULL,
    "short"     TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "roster_role_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "roster_role_org_code_key" ON "roster_role"("orgId", "code");

CREATE TABLE IF NOT EXISTS "roster_assignment" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "orgId"     TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,   -- YYYY-MM-DD
    "kind"      TEXT NOT NULL,   -- 'tech' | 'pm'
    "roleId"    TEXT,            -- roster_role.id; NULL for pm
    "userId"    TEXT NOT NULL,
    CONSTRAINT "roster_assignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "roster_assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "roster_assignment_week_idx" ON "roster_assignment"("orgId", "weekStart");
