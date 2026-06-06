# ShowPilot — Kiosk API Contract

Read-only endpoints that power the kiosk Org Chart and On-Duty Roster pages. Designed to drop into the existing Cloudflare Workers + D1 stack and sit behind the RBAC layer.

---

## Design principles

- **Read-only.** The kiosk never writes. These endpoints are GET-only and scoped so a leaked kiosk token can't mutate anything.
- **Self-describing.** Colours, role labels, and ordering come from the API, not hardcoded in the kiosk. Change a team colour in ShowPilot → every screen updates.
- **Namespaced.** All kiosk endpoints live under `/api/v1/kiosk/*` so they're trivially scoped in RBAC and easy to rate-limit/cache separately from the main app API.
- **Fail-soft.** The kiosk caches the last good response and falls back to demo data, so a 500 never blanks a live screen. Nothing required server-side for this, just don't break the response shape.

---

## Authentication

A dedicated kiosk token, not a user session.

```
Authorization: Bearer ksk_<random>
```

- Issued per organization (or per display group) from ShowPilot settings.
- Carries exactly three RBAC scopes: `org:read`, `roster:read`, and `assets:read`. Nothing else.
- Org is resolved from the token — the kiosk never passes an org ID in the URL.

> LAN-only alternative: a per-display public key as `?key=` is simpler but unauthenticated. Prefer the Bearer token unless the display is on an isolated VLAN.

---

## Conventions

| Aspect | Rule |
|---|---|
| Timestamps | ISO 8601 UTC, e.g. `2026-06-06T12:00:00Z` |
| Date-only | `YYYY-MM-DD` |
| Colours | Hex string, e.g. `#22d3ee` (drives the kiosk accent for that team) |
| Caching | `Cache-Control: public, max-age=60` — kiosk polls every 60s; cache in KV for 60s |
| Errors | `{ "error": { "code": "...", "message": "..." } }` |
| Status codes | 200 OK · 401 missing/invalid token · 403 scope denied · 404 unknown resource · 500 server |

---

## Endpoint 1 — Org structure

```
GET /api/v1/kiosk/org
```

Powers the Org Chart page. Returns the Technical Manager at the apex, then teams (each with a lead + members).

### Response 200

```json
{
  "organization": { "id": "org_faithfire", "name": "Faithfire Production" },
  "technicalManager": {
    "id": "usr_rey",
    "name": "Rey Disse",
    "title": "Technical Manager",
    "initials": "RD",
    "avatarUrl": null
  },
  "teams": [
    {
      "id": "team_audio",
      "name": "Audio",
      "color": "#22d3ee",
      "sortOrder": 1,
      "lead": {
        "id": "usr_james",
        "name": "James Kwarteng",
        "initials": "JK",
        "avatarUrl": null
      },
      "members": [
        { "id": "usr_mike",  "name": "Mike Tran",     "initials": "MT", "avatarUrl": null },
        { "id": "usr_grace", "name": "Grace Boateng", "initials": "GB", "avatarUrl": null }
      ]
    }
  ],
  "updatedAt": "2026-06-06T12:00:00Z"
}
```

### Notes
- `initials` can be derived server-side or by the kiosk; sending it avoids duplicate logic.
- `avatarUrl` is optional — kiosk falls back to initials when `null`.
- `teams` is pre-sorted by `sortOrder`; kiosk renders in array order.

---

## Endpoint 2 — On-Duty roster

```
GET /api/v1/kiosk/roster?month=YYYY-MM
```

Powers the On-Duty page. `month` is optional and defaults to the current month in the org's timezone. Returns the role definitions once, then one entry per week.

### Response 200

```json
{
  "month": "2026-06",
  "timezone": "America/Toronto",
  "techRoles": [
    { "id": "tm",     "name": "Technical Manager",  "short": "TM" },
    { "id": "audio",  "name": "Audio / FOH",        "short": "Audio" },
    { "id": "cam1",   "name": "Camera 1",           "short": "Cam 1" },
    { "id": "cam2",   "name": "Camera 2",           "short": "Cam 2" },
    { "id": "pro",    "name": "ProPresenter",       "short": "Pro" },
    { "id": "stream", "name": "Stream",             "short": "Stream" }
  ],
  "weeks": [
    {
      "weekStart": "2026-06-01",
      "weekEnd": "2026-06-07",
      "isCurrent": true,
      "tech": [
        { "roleId": "tm",     "person": { "id": "usr_rey",   "name": "Rey Disse",       "initials": "RD" } },
        { "roleId": "audio",  "person": { "id": "usr_james", "name": "James Kwarteng",  "initials": "JK" } },
        { "roleId": "cam1",   "person": { "id": "usr_mike",  "name": "Mike Tran",       "initials": "MT" } },
        { "roleId": "cam2",   "person": { "id": "usr_lisa",  "name": "Lisa Park",       "initials": "LP" } },
        { "roleId": "pro",    "person": { "id": "usr_david", "name": "David Owusu",     "initials": "DO" } },
        { "roleId": "stream", "person": { "id": "usr_anna",  "name": "Anna Reyes",      "initials": "AR" } }
      ],
      "pm": { "id": "usr_sarah", "name": "Sarah Mensah", "initials": "SM" }
    }
  ],
  "updatedAt": "2026-06-06T12:00:00Z"
}
```

### Notes
- `isCurrent: true` on exactly one week (the one containing "today") — the kiosk highlights it as the hero card.
- A role with no one assigned: omit it from `tech`, or send `"person": null`. Kiosk renders an empty slot either way.
- `pm` may be `null` if unassigned.
- Weeks are pre-sorted ascending by `weekStart`.

---

## Endpoint 3 — Asset status

```
GET /api/v1/kiosk/assets
```

Powers the Asset Status board. Physical production gear and its operational state — distinct from the uptime monitor, which watches services. Returns a flat asset list plus a rolled-up summary so the kiosk can show counts at a glance without recomputing.

### Status values

| Status | Meaning | Suggested kiosk colour |
|---|---|---|
| `operational` | Working, ready to use | green |
| `degraded` | Usable but with a known issue | amber |
| `down` | Broken / not usable | red |
| `maintenance` | Out for service or being worked on | blue |
| `retired` | Decommissioned, kept for record | grey |

Status colour is the one place colour stays meaningful even in the minimal theme — it encodes critical state, so it's not decorative.

### Response 200

```json
{
  "summary": {
    "total": 16,
    "operational": 12,
    "degraded": 1,
    "down": 2,
    "maintenance": 1,
    "retired": 0
  },
  "assets": [
    {
      "id": "ast_atem",
      "name": "ATEM SDI Extreme ISO",
      "category": "Video",
      "status": "operational",
      "location": "Production Booth",
      "ipAddress": "192.168.2.218",
      "lastCheckedAt": "2026-06-06T09:00:00Z",
      "note": null
    },
    {
      "id": "ast_x32",
      "name": "Behringer X32",
      "category": "Audio",
      "status": "degraded",
      "location": "FOH",
      "ipAddress": "192.168.2.216",
      "lastCheckedAt": "2026-06-06T09:00:00Z",
      "note": "Channel 14 preamp intermittent"
    },
    {
      "id": "ast_cam3",
      "name": "Gimbal Camera (Hollyland)",
      "category": "Video",
      "status": "down",
      "location": "Stage",
      "ipAddress": null,
      "lastCheckedAt": "2026-06-05T21:00:00Z",
      "note": "Battery plate cracked — replacement ordered"
    }
  ],
  "updatedAt": "2026-06-06T12:00:00Z"
}
```

### Notes
- `category` groups assets on the board (Video, Audio, Lighting, Streaming, Compute / Network, Stage). The kiosk sections by category in array order.
- `status` is the source of truth — set manually in ShowPilot, or written by a monitor job (e.g. a Worker cron that pings `ipAddress` and flips `operational`/`down`). The kiosk doesn't care which; it just renders the field.
- `ipAddress`, `location`, and `note` are optional (`null` when absent). A `note` surfaces on the board for any non-operational asset so crew see *why* it's down.
- `lastCheckedAt` lets the kiosk show staleness (e.g. dim assets not verified in 30+ days).
- `summary` is server-computed so the kiosk header can show "12 / 16 operational" instantly.

---

## Suggested D1 schema

Minimal additions — reuses your existing `users` table for people.

```sql
CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#3b82f6',
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE team_members (
  team_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('lead','member')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE roster_roles (
  id          TEXT PRIMARY KEY,   -- 'tm', 'audio', ...
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  short       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE roster_assignments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  week_start  TEXT NOT NULL,      -- YYYY-MM-DD
  kind        TEXT NOT NULL CHECK (kind IN ('tech','pm')),
  role_id     TEXT,              -- null for pm
  user_id     TEXT NOT NULL
);

CREATE INDEX idx_roster_week ON roster_assignments (org_id, week_start);

CREATE TABLE assets (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'operational'
                    CHECK (status IN ('operational','degraded','down','maintenance','retired')),
  location        TEXT,
  ip_address      TEXT,
  note            TEXT,
  last_checked_at TEXT,             -- ISO 8601
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_assets_org ON assets (org_id, category, sort_order);
```

The three endpoints are then a few joined SELECTs shaped into the JSON above. The asset `summary` is a single `GROUP BY status` count. Cache each response in KV keyed by `org_id` (+ `month` for the roster) with a 60s TTL; bust the key on any write to the underlying tables. If a cron monitor updates asset status, let it write straight to the `assets` row and bust the assets key.

---

## RBAC mapping

- `GET /api/v1/kiosk/org` → requires `org:read`
- `GET /api/v1/kiosk/roster` → requires `roster:read`
- `GET /api/v1/kiosk/assets` → requires `assets:read`

All three fit the existing `resource:action` primitive model. The kiosk token grants only these three; every other primitive is denied by default.
