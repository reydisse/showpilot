-- ============================================================
-- ShowPilot Test Tenant Seed Data
-- Org: Grace Church (slug: grace-church)
-- Login: mahali@test.com (existing user, use signup password)
-- ============================================================
-- This script is idempotent — uses INSERT OR IGNORE throughout.
-- Run with: sqlite3 <db-path> < scripts/seed-test-tenant.sql
-- Or: wrangler d1 execute showpilot-db --local --file=scripts/seed-test-tenant.sql
-- ============================================================

-- Org ID reference
-- mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x = Grace Church

-- ─── Crew Members ────────────────────────────────────────────
INSERT OR IGNORE INTO crew_member (id, orgId, memberId, name, role, photoUrl, isOnline, lastCheckIn, createdAt)
VALUES
  ('seed-crew-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-01', 'James Mensah', 'Technical Director', '', 1, '2026-03-12T08:30:00Z', '2026-01-15T10:00:00Z'),
  ('seed-crew-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-02', 'Sarah Osei', 'Audio Engineer', '', 1, '2026-03-12T08:35:00Z', '2026-01-15T10:00:00Z'),
  ('seed-crew-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-03', 'Daniel Appiah', 'Camera 1', '', 1, '2026-03-12T08:40:00Z', '2026-01-15T10:00:00Z'),
  ('seed-crew-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-04', 'Abena Darko', 'Camera 2', '', 0, NULL, '2026-01-15T10:00:00Z'),
  ('seed-crew-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-05', 'Kwame Boateng', 'Graphics Operator', '', 1, '2026-03-12T08:32:00Z', '2026-01-15T10:00:00Z'),
  ('seed-crew-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-06', 'Priscilla Asante', 'Stream Director', '', 1, '2026-03-12T08:28:00Z', '2026-01-15T10:00:00Z'),
  ('seed-crew-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-07', 'Emmanuel Tetteh', 'Lighting', '', 0, NULL, '2026-01-15T10:00:00Z'),
  ('seed-crew-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-08', 'Nana Ama', 'Stage Manager', '', 1, '2026-03-12T08:45:00Z', '2026-01-15T10:00:00Z'),
  ('seed-crew-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-09', 'Kofi Ansah', 'ProPresenter', '', 0, NULL, '2026-02-01T10:00:00Z'),
  ('seed-crew-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'crew-10', 'Esi Mensah', 'Comms', '', 1, '2026-03-12T08:50:00Z', '2026-02-01T10:00:00Z');

-- ─── Checklist Templates ─────────────────────────────────────
INSERT OR IGNORE INTO checklist_template (id, orgId, label, category, sortOrder, createdAt)
VALUES
  ('seed-cl-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'FOH console powered on', 'audio', 1, '2026-01-15T10:00:00Z'),
  ('seed-cl-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Monitor console powered on', 'audio', 2, '2026-01-15T10:00:00Z'),
  ('seed-cl-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'All wireless mics charged & tested', 'audio', 3, '2026-01-15T10:00:00Z'),
  ('seed-cl-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'In-ear monitor packs distributed', 'audio', 4, '2026-01-15T10:00:00Z'),
  ('seed-cl-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Stream encoder connected & test slate sent', 'stream', 1, '2026-01-15T10:00:00Z'),
  ('seed-cl-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'YouTube/Facebook destinations verified', 'stream', 2, '2026-01-15T10:00:00Z'),
  ('seed-cl-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'All cameras powered & white-balanced', 'video', 1, '2026-01-15T10:00:00Z'),
  ('seed-cl-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Video switcher scenes loaded', 'video', 2, '2026-01-15T10:00:00Z'),
  ('seed-cl-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'ProPresenter slides loaded & tested', 'video', 3, '2026-01-15T10:00:00Z'),
  ('seed-cl-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'House lights preset loaded', 'lighting', 1, '2026-01-15T10:00:00Z'),
  ('seed-cl-11', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Stage wash & band lighting tested', 'lighting', 2, '2026-01-15T10:00:00Z'),
  ('seed-cl-12', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Comms headsets distributed', 'general', 1, '2026-01-15T10:00:00Z'),
  ('seed-cl-13', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Pre-service prayer completed', 'general', 2, '2026-01-15T10:00:00Z');

-- ─── Graphic Templates ───────────────────────────────────────
INSERT OR IGNORE INTO graphic_template (id, orgId, name, title, subtitle, style, createdAt, updatedAt)
VALUES
  ('seed-gfx-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Pastor Welcome', 'Pastor James Mensah', 'Lead Pastor', '{"position":"bottom-left","animation":"slide-up"}', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-gfx-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Worship Leader', 'Ama Serwaa', 'Worship Leader', '{"position":"bottom-left","animation":"slide-up"}', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-gfx-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Scripture — John 3:16', 'John 3:16', 'For God so loved the world...', '{"position":"center","animation":"fade-in","type":"scripture"}', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-gfx-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Offering Prompt', 'Give Online', 'gracechurch.org/give', '{"position":"bottom-left","animation":"slide-up"}', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-gfx-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Announcements', 'Youth Conference 2026', 'Register at the Welcome Desk', '{"position":"bottom-left","animation":"slide-up"}', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-gfx-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Guest Speaker', 'Rev. Kwesi Adu', 'Guest Minister', '{"position":"bottom-left","animation":"slide-up"}', '2026-02-01T10:00:00Z', '2026-02-01T10:00:00Z');

-- ─── Equipment ───────────────────────────────────────────────
INSERT OR IGNORE INTO equipment (id, orgId, name, category, status, location, serialNumber, notes, createdAt, updatedAt)
VALUES
  ('seed-eq-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Behringer X32', 'audio', 'operational', 'FOH Booth', 'X32-2024-001', 'Main FOH console', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Behringer X32 Compact', 'audio', 'operational', 'Stage Left', 'X32C-2024-002', 'Monitor console', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Shure QLXD2 SM58', 'audio', 'operational', 'Mic Rack', 'QLXD-001', 'Pastor handheld', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Shure QLXD2 SM58', 'audio', 'needs-repair', 'Mic Rack', 'QLXD-002', 'Intermittent dropout — needs antenna check', '2026-01-15T10:00:00Z', '2026-03-01T10:00:00Z'),
  ('seed-eq-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Blackmagic ATEM Mini Pro ISO', 'video', 'operational', 'Production Booth', 'ATEM-001', 'Main video switcher', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'PTZ Camera — NDI', 'video', 'operational', 'Rear Balcony', 'PTZ-001', 'Wide shot', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Canon XA55', 'video', 'operational', 'Stage Right Tripod', 'XA55-001', 'Camera 1 — close-up', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Elgato Stream Deck XL', 'streaming', 'operational', 'Production Booth', 'SD-001', 'Scene switching & macros', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Chauvet SlimPAR 64', 'lighting', 'operational', 'Stage Truss', '', 'Stage wash x8', '2026-01-15T10:00:00Z', '2026-01-15T10:00:00Z'),
  ('seed-eq-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'ClearCom MS-702', 'comms', 'out-of-service', 'Storage', 'CC-702-001', 'Replaced with wireless — legacy unit', '2026-01-15T10:00:00Z', '2026-02-15T10:00:00Z');

-- ─── Mic Assignments (for today's service) ───────────────────
INSERT OR IGNORE INTO mic_assignment (id, orgId, channel, label, micType, micModel, notes, gainDb, phantom, muted, "group", mixerConsole, mixerChannel, mixerChannelType, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-mic-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Pastor', 'wireless-handheld', 'Shure QLXD2 SM58', '', -6.0, 0, 0, 'vocals', 'X32 FOH', 1, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-mic-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Worship Leader', 'wireless-handheld', 'Shure QLXD2 SM58', '', -4.0, 0, 0, 'vocals', 'X32 FOH', 2, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-mic-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 3, 'BV 1', 'wireless-lav', 'Shure QLXD1 WL185', '', -8.0, 0, 1, 'vocals', 'X32 FOH', 3, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-mic-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 4, 'BV 2', 'wireless-lav', 'Shure QLXD1 WL185', '', -8.0, 0, 1, 'vocals', 'X32 FOH', 4, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-mic-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 5, 'Keys L', 'di-box', 'Radial J48', '', 0.0, 1, 0, 'band', 'X32 FOH', 9, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-mic-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 6, 'Keys R', 'di-box', 'Radial J48', '', 0.0, 1, 0, 'band', 'X32 FOH', 10, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-mic-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 7, 'Electric Guitar', 'wired', 'Shure SM57', 'Amp mic', -2.0, 0, 0, 'band', 'X32 FOH', 11, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-mic-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 8, 'Bass DI', 'di-box', 'Radial JDI', '', 0.0, 0, 0, 'band', 'X32 FOH', 12, 'mono', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z');

-- ─── App Settings ────────────────────────────────────────────
INSERT OR IGNORE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-set-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'clock-format', '12hr'),
  ('seed-set-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'lower-third-style', 'default'),
  ('seed-set-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'lower-third-auto-clear', '8'),
  ('seed-set-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'chat-adapter', 'native');

-- ─── Rundown Items (today's service) ─────────────────────────
-- Stored as JSON in app_setting with key rundown-items:2026-03-12
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rundown-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-12', '[
  {"id":"rd-01","title":"Pre-Service Loop","type":"segment","duration":600000,"notes":"Countdown video + background music","assignee":"Kwame"},
  {"id":"rd-02","title":"Welcome & Call to Worship","type":"segment","duration":180000,"notes":"Pastor James opens","assignee":"James"},
  {"id":"rd-03","title":"Praise — Great Are You Lord","type":"song","duration":300000,"notes":"Key of G, click track ch 15-16","assignee":"Ama"},
  {"id":"rd-04","title":"Praise — Way Maker","type":"song","duration":360000,"notes":"Key of E, build from verse 2","assignee":"Ama"},
  {"id":"rd-05","title":"Worship — Goodness of God","type":"song","duration":420000,"notes":"Key of A, extended worship bridge","assignee":"Ama"},
  {"id":"rd-06","title":"Prayer","type":"prayer","duration":180000,"notes":"Transition lighting cue after prayer","assignee":"James"},
  {"id":"rd-07","title":"Offering","type":"offering","duration":240000,"notes":"Display giving graphic, play offering loop","assignee":"Kwame"},
  {"id":"rd-08","title":"Announcements","type":"announcement","duration":180000,"notes":"Youth conference, midweek service, volunteer signup","assignee":"Nana Ama"},
  {"id":"rd-09","title":"Scripture Reading — Romans 8:28","type":"segment","duration":120000,"notes":"NIV, display on screen","assignee":"Kwame"},
  {"id":"rd-10","title":"Sermon — Walking in Purpose","type":"segment","duration":2400000,"notes":"40 min sermon, 3 slides, scripture inserts","assignee":"James"},
  {"id":"rd-11","title":"Altar Call","type":"prayer","duration":300000,"notes":"Soft music, dim house lights","assignee":"James"},
  {"id":"rd-12","title":"Closing Song — Blessed Assurance","type":"song","duration":240000,"notes":"Key of D, hymn arrangement","assignee":"Ama"},
  {"id":"rd-13","title":"Benediction & Dismissal","type":"segment","duration":120000,"notes":"House lights up after blessing","assignee":"James"},
  {"id":"rd-14","title":"Post-Service Loop","type":"segment","duration":300000,"notes":"Exit music + connect card slide","assignee":"Kwame"}
]');

-- ─── Rundown Timer (reset for today) ─────────────────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rundown-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-12', '{"playback":"stop","currentItemId":"rd-01","elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ═══════════════════════════════════════════════════════════════
-- NEXT 7 DAYS — Demo Rundowns (2026-03-13 through 2026-03-19)
-- ═══════════════════════════════════════════════════════════════

-- ─── 2026-03-13 (Friday) — Friday Night Service ───────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rd-0313-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-13', '[
  {"id":"fri-01","title":"Doors Open / Pre-Service Mix","type":"segment","duration":600000,"notes":"Ambient music, welcome slide loop","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":0,"hardStop":false},
  {"id":"fri-02","title":"Welcome & Opening Prayer","type":"segment","duration":180000,"notes":"Host opens — Nana Ama","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":1,"hardStop":false},
  {"id":"fri-03","title":"Praise — Jireh","type":"song","duration":300000,"notes":"Key of C, Maverick City arrangement","assignee":"Ama","cue":"","status":"upcoming","sortOrder":2,"hardStop":false},
  {"id":"fri-04","title":"Praise — This Is How I Fight My Battles","type":"song","duration":360000,"notes":"Key of Bb, build at bridge","assignee":"Ama","cue":"","status":"upcoming","sortOrder":3,"hardStop":false},
  {"id":"fri-05","title":"Worship — Holy Spirit","type":"song","duration":420000,"notes":"Key of D, extended spontaneous section","assignee":"Ama","cue":"","status":"upcoming","sortOrder":4,"hardStop":false},
  {"id":"fri-06","title":"Offering","type":"offering","duration":240000,"notes":"Show giving slide, play offering loop","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":5,"hardStop":false},
  {"id":"fri-07","title":"Scripture Reading — Psalm 23","type":"segment","duration":120000,"notes":"Read from NIV, display on PP","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":6,"hardStop":false},
  {"id":"fri-08","title":"Sermon — The Good Shepherd","type":"segment","duration":2100000,"notes":"35 min sermon, 4 key slides","assignee":"James","cue":"","status":"upcoming","sortOrder":7,"hardStop":false},
  {"id":"fri-09","title":"Altar Call & Ministry Time","type":"prayer","duration":600000,"notes":"Soft worship pad, dim lights","assignee":"James","cue":"","status":"upcoming","sortOrder":8,"hardStop":false},
  {"id":"fri-10","title":"Closing Song — Amazing Grace","type":"song","duration":240000,"notes":"Key of G, traditional arrangement","assignee":"Ama","cue":"","status":"upcoming","sortOrder":9,"hardStop":false},
  {"id":"fri-11","title":"Benediction","type":"segment","duration":120000,"notes":"House lights up after blessing","assignee":"James","cue":"","status":"upcoming","sortOrder":10,"hardStop":false}
]'),
  ('seed-rd-0313-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-13', '{"playback":"stop","currentItemId":null,"elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ─── 2026-03-14 (Saturday) — Youth Night ──────────────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rd-0314-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-14', '[
  {"id":"sat-01","title":"Pre-Show Hype Loop","type":"segment","duration":300000,"notes":"Upbeat countdown, energy music","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":0,"hardStop":false},
  {"id":"sat-02","title":"MC Welcome & Icebreaker","type":"segment","duration":300000,"notes":"Youth pastor opens, crowd game","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":1,"hardStop":false},
  {"id":"sat-03","title":"Worship Set — Praise","type":"song","duration":480000,"notes":"High energy set — 2 songs back to back","assignee":"Ama","cue":"","status":"upcoming","sortOrder":2,"hardStop":false},
  {"id":"sat-04","title":"Worship Set — Slow","type":"song","duration":360000,"notes":"Key of G, intimate worship","assignee":"Ama","cue":"","status":"upcoming","sortOrder":3,"hardStop":false},
  {"id":"sat-05","title":"Announcements & Offering","type":"announcement","duration":180000,"notes":"Youth conference promo video","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":4,"hardStop":false},
  {"id":"sat-06","title":"Message — Identity in Christ","type":"segment","duration":1500000,"notes":"25 min message, interactive with polls","assignee":"James","cue":"","status":"upcoming","sortOrder":5,"hardStop":false},
  {"id":"sat-07","title":"Response Song","type":"song","duration":300000,"notes":"Key of A, acoustic","assignee":"Ama","cue":"","status":"upcoming","sortOrder":6,"hardStop":false},
  {"id":"sat-08","title":"Small Group Breakout","type":"segment","duration":900000,"notes":"15 min discussion groups, house lights up","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":7,"hardStop":false},
  {"id":"sat-09","title":"Closing & Dismiss","type":"segment","duration":120000,"notes":"Recap, next week promo","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":8,"hardStop":false}
]'),
  ('seed-rd-0314-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-14', '{"playback":"stop","currentItemId":null,"elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ─── 2026-03-15 (Sunday) — Sunday Morning Service ─────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rd-0315-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-15', '[
  {"id":"sun-01","title":"Pre-Service Countdown","type":"segment","duration":600000,"notes":"5-min countdown at T-5, welcome slides before","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":0,"hardStop":true},
  {"id":"sun-02","title":"Welcome & Call to Worship","type":"segment","duration":180000,"notes":"Pastor James opens, prayer","assignee":"James","cue":"","status":"upcoming","sortOrder":1,"hardStop":false},
  {"id":"sun-03","title":"Praise — Raise a Hallelujah","type":"song","duration":300000,"notes":"Key of A, full band","assignee":"Ama","cue":"","status":"upcoming","sortOrder":2,"hardStop":false},
  {"id":"sun-04","title":"Praise — No Longer Slaves","type":"song","duration":360000,"notes":"Key of F, choir joins on chorus 2","assignee":"Ama","cue":"","status":"upcoming","sortOrder":3,"hardStop":false},
  {"id":"sun-05","title":"Worship — O Come to the Altar","type":"song","duration":420000,"notes":"Key of Bb, extended outro","assignee":"Ama","cue":"","status":"upcoming","sortOrder":4,"hardStop":false},
  {"id":"sun-06","title":"Worship — Here Again","type":"song","duration":360000,"notes":"Key of B, intimate moment","assignee":"Ama","cue":"","status":"upcoming","sortOrder":5,"hardStop":false},
  {"id":"sun-07","title":"Tithes & Offering","type":"offering","duration":300000,"notes":"Offering video, then giving slide with QR","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":6,"hardStop":false},
  {"id":"sun-08","title":"Announcements","type":"announcement","duration":240000,"notes":"3 announcements max, keep tight","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":7,"hardStop":true},
  {"id":"sun-09","title":"Special Music — Choir","type":"song","duration":300000,"notes":"Choir anthem, pre-recorded track","assignee":"Ama","cue":"","status":"upcoming","sortOrder":8,"hardStop":false},
  {"id":"sun-10","title":"Scripture — Ephesians 2:8-10","type":"segment","duration":120000,"notes":"ESV translation on PP","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":9,"hardStop":false},
  {"id":"sun-11","title":"Sermon — Saved by Grace","type":"segment","duration":2700000,"notes":"45 min sermon, 6 slides, 2 video clips","assignee":"James","cue":"","status":"upcoming","sortOrder":10,"hardStop":false},
  {"id":"sun-12","title":"Altar Call","type":"prayer","duration":300000,"notes":"Soft keys, dim house, prayer team forward","assignee":"James","cue":"","status":"upcoming","sortOrder":11,"hardStop":false},
  {"id":"sun-13","title":"Closing Song — Great Is Thy Faithfulness","type":"song","duration":240000,"notes":"Key of D, hymn arrangement, choir leads","assignee":"Ama","cue":"","status":"upcoming","sortOrder":12,"hardStop":false},
  {"id":"sun-14","title":"Benediction & Dismissal","type":"segment","duration":120000,"notes":"House lights, exit music","assignee":"James","cue":"","status":"upcoming","sortOrder":13,"hardStop":false},
  {"id":"sun-15","title":"Post-Service Loop","type":"segment","duration":300000,"notes":"Connect card slides, exit music mix","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":14,"hardStop":false}
]'),
  ('seed-rd-0315-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-15', '{"playback":"stop","currentItemId":null,"elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ─── 2026-03-16 (Monday) — Monday Bible Study ────────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rd-0316-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-16', '[
  {"id":"mon-01","title":"Welcome & Opening Song","type":"segment","duration":180000,"notes":"Acoustic only, casual atmosphere","assignee":"Ama","cue":"","status":"upcoming","sortOrder":0,"hardStop":false},
  {"id":"mon-02","title":"Opening Prayer","type":"prayer","duration":120000,"notes":"","assignee":"James","cue":"","status":"upcoming","sortOrder":1,"hardStop":false},
  {"id":"mon-03","title":"Bible Study — Romans 8 (Part 1)","type":"segment","duration":1800000,"notes":"30 min teaching, discussion questions on PP","assignee":"James","cue":"","status":"upcoming","sortOrder":2,"hardStop":false},
  {"id":"mon-04","title":"Group Discussion","type":"segment","duration":900000,"notes":"15 min table discussions, house lights up","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":3,"hardStop":false},
  {"id":"mon-05","title":"Q&A","type":"segment","duration":600000,"notes":"Open mic Q&A","assignee":"James","cue":"","status":"upcoming","sortOrder":4,"hardStop":false},
  {"id":"mon-06","title":"Closing Prayer","type":"prayer","duration":120000,"notes":"","assignee":"James","cue":"","status":"upcoming","sortOrder":5,"hardStop":false}
]'),
  ('seed-rd-0316-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-16', '{"playback":"stop","currentItemId":null,"elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ─── 2026-03-17 (Tuesday) — Prayer & Worship Night ────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rd-0317-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-17', '[
  {"id":"tue-01","title":"Soaking Music & Gathering","type":"segment","duration":600000,"notes":"Soft instrumental, prayer room atmosphere","assignee":"Ama","cue":"","status":"upcoming","sortOrder":0,"hardStop":false},
  {"id":"tue-02","title":"Opening Scripture — Psalm 95:1-7","type":"segment","duration":120000,"notes":"Read slowly, let it breathe","assignee":"James","cue":"","status":"upcoming","sortOrder":1,"hardStop":false},
  {"id":"tue-03","title":"Worship Set — Intimate","type":"song","duration":900000,"notes":"15 min continuous worship, no breaks between songs","assignee":"Ama","cue":"","status":"upcoming","sortOrder":2,"hardStop":false},
  {"id":"tue-04","title":"Corporate Prayer","type":"prayer","duration":1200000,"notes":"20 min guided prayer, topics on PP slides","assignee":"James","cue":"","status":"upcoming","sortOrder":3,"hardStop":false},
  {"id":"tue-05","title":"Worship Response","type":"song","duration":600000,"notes":"10 min spontaneous worship, follow the room","assignee":"Ama","cue":"","status":"upcoming","sortOrder":4,"hardStop":false},
  {"id":"tue-06","title":"Closing Word & Benediction","type":"segment","duration":180000,"notes":"Short encouragement, 3 min max","assignee":"James","cue":"","status":"upcoming","sortOrder":5,"hardStop":false}
]'),
  ('seed-rd-0317-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-17', '{"playback":"stop","currentItemId":null,"elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ─── 2026-03-18 (Wednesday) — Midweek Service ────────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rd-0318-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-18', '[
  {"id":"wed-01","title":"Pre-Service Loop","type":"segment","duration":300000,"notes":"Countdown + welcome slides","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":0,"hardStop":false},
  {"id":"wed-02","title":"Welcome","type":"segment","duration":120000,"notes":"Quick welcome, straight to worship","assignee":"Nana Ama","cue":"","status":"upcoming","sortOrder":1,"hardStop":false},
  {"id":"wed-03","title":"Worship — Build My Life","type":"song","duration":300000,"notes":"Key of G, acoustic-led","assignee":"Ama","cue":"","status":"upcoming","sortOrder":2,"hardStop":false},
  {"id":"wed-04","title":"Worship — What A Beautiful Name","type":"song","duration":360000,"notes":"Key of D, full arrangement","assignee":"Ama","cue":"","status":"upcoming","sortOrder":3,"hardStop":false},
  {"id":"wed-05","title":"Prayer Transition","type":"prayer","duration":120000,"notes":"Bridge from worship to teaching","assignee":"James","cue":"","status":"upcoming","sortOrder":4,"hardStop":false},
  {"id":"wed-06","title":"Teaching — Romans 8 (Part 2)","type":"segment","duration":1800000,"notes":"30 min teaching, follows Monday study","assignee":"James","cue":"","status":"upcoming","sortOrder":5,"hardStop":false},
  {"id":"wed-07","title":"Testimony","type":"segment","duration":300000,"notes":"Pre-recorded testimony video — 5 min","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":6,"hardStop":true},
  {"id":"wed-08","title":"Offering","type":"offering","duration":180000,"notes":"Quick offering moment, QR code slide","assignee":"Kwame","cue":"","status":"upcoming","sortOrder":7,"hardStop":false},
  {"id":"wed-09","title":"Closing Song — 10,000 Reasons","type":"song","duration":300000,"notes":"Key of G, congregational","assignee":"Ama","cue":"","status":"upcoming","sortOrder":8,"hardStop":false},
  {"id":"wed-10","title":"Benediction","type":"segment","duration":120000,"notes":"","assignee":"James","cue":"","status":"upcoming","sortOrder":9,"hardStop":false}
]'),
  ('seed-rd-0318-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-18', '{"playback":"stop","currentItemId":null,"elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ─── 2026-03-19 (Thursday) — Rehearsal & Tech Run ─────────────
INSERT OR REPLACE INTO app_setting (id, orgId, key, value)
VALUES
  ('seed-rd-0319-items', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-items:2026-03-19', '[
  {"id":"thu-01","title":"Band Load-In & Soundcheck","type":"segment","duration":1800000,"notes":"30 min — drums, bass, keys, guitars, vocals","assignee":"Sarah","cue":"","status":"upcoming","sortOrder":0,"hardStop":false},
  {"id":"thu-02","title":"Vocal Rehearsal","type":"song","duration":1200000,"notes":"20 min — run all Sunday songs with click","assignee":"Ama","cue":"","status":"upcoming","sortOrder":1,"hardStop":false},
  {"id":"thu-03","title":"Camera Blocking","type":"segment","duration":900000,"notes":"15 min — walk through shots with director","assignee":"Daniel","cue":"","status":"upcoming","sortOrder":2,"hardStop":false},
  {"id":"thu-04","title":"Lighting Cue Programming","type":"segment","duration":900000,"notes":"15 min — program scenes for Sunday","assignee":"Emmanuel","cue":"","status":"upcoming","sortOrder":3,"hardStop":false},
  {"id":"thu-05","title":"Full Run-Through","type":"segment","duration":3600000,"notes":"60 min — full service simulation, no stops","assignee":"James","cue":"","status":"upcoming","sortOrder":4,"hardStop":true},
  {"id":"thu-06","title":"Notes & Debrief","type":"segment","duration":600000,"notes":"10 min — TD gives notes, adjustments for Sunday","assignee":"James","cue":"","status":"upcoming","sortOrder":5,"hardStop":false},
  {"id":"thu-07","title":"Strike & Lock Up","type":"segment","duration":600000,"notes":"10 min — power down, secure equipment","assignee":"Sarah","cue":"","status":"upcoming","sortOrder":6,"hardStop":false}
]'),
  ('seed-rd-0319-timer', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'rundown-timer:2026-03-19', '{"playback":"stop","currentItemId":null,"elapsed":0,"startedAt":null,"pausedAt":null,"mode":"count-down","serverTime":0}');

-- ─── Chat Messages (sample production chat) ─────────────────
INSERT OR IGNORE INTO chat_message (id, orgId, message, senderName, createdAt)
VALUES
  ('seed-chat-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'All cameras powered up and white-balanced', 'Daniel Appiah', '2026-03-12T08:40:00Z'),
  ('seed-chat-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'FOH console is up. Soundcheck starting in 5', 'Sarah Osei', '2026-03-12T08:41:00Z'),
  ('seed-chat-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Stream test slate sent — YouTube and Facebook look good', 'Priscilla Asante', '2026-03-12T08:43:00Z'),
  ('seed-chat-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'ProPresenter slides loaded. 14 slides for sermon', 'Kwame Boateng', '2026-03-12T08:45:00Z'),
  ('seed-chat-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Mic 2 showing intermittent dropout — switching to backup', 'Sarah Osei', '2026-03-12T08:50:00Z'),
  ('seed-chat-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Backup mic is clean. We are good', 'Sarah Osei', '2026-03-12T08:52:00Z'),
  ('seed-chat-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Stage lighting cues loaded — 4 scenes ready', 'Emmanuel Tetteh', '2026-03-12T08:55:00Z'),
  ('seed-chat-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'All comms headsets distributed. Full check complete', 'Esi Mensah', '2026-03-12T08:58:00Z'),
  ('seed-chat-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Pre-service prayer in 2 minutes — everyone to green room', 'James Mensah', '2026-03-12T09:00:00Z'),
  ('seed-chat-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'Standing by for countdown. Going live at 9:30', 'James Mensah', '2026-03-12T09:15:00Z');

-- ─── Cue Sheet (today's service) ─────────────────────────────
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Welcome & Call to Worship', 'CAM1: CU Pastor, CAM2: Wide', 'Fade up from countdown', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-cue-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Praise — Great Are You Lord', 'CAM1: WL CU, CAM2: Band wide, PTZ: Congregation', 'Cut to lyrics on chorus', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-cue-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 3, 'Sermon', 'CAM1: Pastor CU, CAM2: Pulpit medium, PTZ: Wide', 'Cut to scripture slides on cue', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z'),
  ('seed-cue-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 4, 'Altar Call', 'CAM2: Wide only', 'No close-ups during altar call — respect privacy', '2026-03-12', '2026-03-12T07:00:00Z', '2026-03-12T07:00:00Z');

-- ═══════════════════════════════════════════════════════════════
-- CUE SHEETS — 2026-03-13 through 2026-03-19
-- ═══════════════════════════════════════════════════════════════

-- 2026-03-13 (Friday Night)
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-fri-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Welcome & Opening Prayer', 'CAM1: Host CU, CAM2: Wide stage', 'Fade up from pre-service loop', '2026-03-13', '2026-03-13T07:00:00Z', '2026-03-13T07:00:00Z'),
  ('seed-cue-fri-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Praise — Jireh', 'CAM1: WL CU, CAM2: Band wide, PTZ: Congregation', 'High energy, fast cuts', '2026-03-13', '2026-03-13T07:00:00Z', '2026-03-13T07:00:00Z'),
  ('seed-cue-fri-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 3, 'Worship — Holy Spirit', 'CAM1: WL medium, CAM2: Wide, PTZ: Slow pan', 'Slow cuts, no fast transitions during intimate worship', '2026-03-13', '2026-03-13T07:00:00Z', '2026-03-13T07:00:00Z'),
  ('seed-cue-fri-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 4, 'Sermon — The Good Shepherd', 'CAM1: Pastor CU, CAM2: Pulpit medium, PTZ: Wide', 'Cut to PP slides on cue from pastor', '2026-03-13', '2026-03-13T07:00:00Z', '2026-03-13T07:00:00Z'),
  ('seed-cue-fri-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 5, 'Altar Call & Ministry Time', 'CAM2: Wide only', 'No close-ups — respect privacy', '2026-03-13', '2026-03-13T07:00:00Z', '2026-03-13T07:00:00Z');

-- 2026-03-14 (Saturday Youth Night)
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-sat-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'MC Welcome & Icebreaker', 'CAM1: MC CU, CAM2: Crowd wide, PTZ: Roaming', 'Capture crowd energy and reactions', '2026-03-14', '2026-03-14T07:00:00Z', '2026-03-14T07:00:00Z'),
  ('seed-cue-sat-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Worship Set — Praise', 'CAM1: WL CU, CAM2: Band wide, PTZ: Congregation', 'Fast cuts for praise, match energy', '2026-03-14', '2026-03-14T07:00:00Z', '2026-03-14T07:00:00Z'),
  ('seed-cue-sat-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 3, 'Message — Identity in Christ', 'CAM1: Speaker CU, CAM2: Wide', 'Poll results go to PP — switch to PP feed on cue', '2026-03-14', '2026-03-14T07:00:00Z', '2026-03-14T07:00:00Z'),
  ('seed-cue-sat-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 4, 'Small Group Breakout', 'PTZ: Wide room shot only', 'House lights up, single camera', '2026-03-14', '2026-03-14T07:00:00Z', '2026-03-14T07:00:00Z');

-- 2026-03-15 (Sunday Morning)
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-sun-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Welcome & Call to Worship', 'CAM1: Pastor CU, CAM2: Wide stage', 'Fade up from countdown at T-0', '2026-03-15', '2026-03-15T07:00:00Z', '2026-03-15T07:00:00Z'),
  ('seed-cue-sun-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Praise — Raise a Hallelujah', 'CAM1: WL CU, CAM2: Band wide, PTZ: Congregation', 'High energy opener — fast cuts OK', '2026-03-15', '2026-03-15T07:00:00Z', '2026-03-15T07:00:00Z'),
  ('seed-cue-sun-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 3, 'Worship — O Come to the Altar', 'CAM1: WL medium, CAM2: Wide, PTZ: Slow pan', 'Intimate moment — slow dissolves only', '2026-03-15', '2026-03-15T07:00:00Z', '2026-03-15T07:00:00Z'),
  ('seed-cue-sun-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 4, 'Special Music — Choir', 'CAM1: Choir wide, CAM2: Director, PTZ: Soloists', 'Follow conductor for section cues', '2026-03-15', '2026-03-15T07:00:00Z', '2026-03-15T07:00:00Z'),
  ('seed-cue-sun-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 5, 'Sermon — Saved by Grace', 'CAM1: Pastor CU, CAM2: Pulpit medium, PTZ: Wide', '6 PP slides — cut on pastor cue. 2 video clips at T+15 and T+28', '2026-03-15', '2026-03-15T07:00:00Z', '2026-03-15T07:00:00Z'),
  ('seed-cue-sun-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 6, 'Altar Call', 'CAM2: Wide only', 'No close-ups — prayer team comes forward', '2026-03-15', '2026-03-15T07:00:00Z', '2026-03-15T07:00:00Z');

-- 2026-03-16 (Monday Bible Study)
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-mon-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Bible Study — Romans 8 (Part 1)', 'CAM1: Teacher CU, PTZ: Wide', 'Single camera for most of study', '2026-03-16', '2026-03-16T07:00:00Z', '2026-03-16T07:00:00Z'),
  ('seed-cue-mon-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Q&A', 'CAM1: Speaker, CAM2: Audience member asking', 'Switch to audience for questions', '2026-03-16', '2026-03-16T07:00:00Z', '2026-03-16T07:00:00Z');

-- 2026-03-17 (Tuesday Prayer & Worship)
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-tue-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Worship Set — Intimate', 'CAM1: WL medium, CAM2: Wide, PTZ: Ambient', 'Slow dissolves only — no hard cuts', '2026-03-17', '2026-03-17T07:00:00Z', '2026-03-17T07:00:00Z'),
  ('seed-cue-tue-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Corporate Prayer', 'CAM2: Wide only', 'Static wide shot, dim lighting', '2026-03-17', '2026-03-17T07:00:00Z', '2026-03-17T07:00:00Z'),
  ('seed-cue-tue-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 3, 'Worship Response', 'CAM1: WL, CAM2: Wide', 'Follow the spontaneous flow', '2026-03-17', '2026-03-17T07:00:00Z', '2026-03-17T07:00:00Z');

-- 2026-03-18 (Wednesday Midweek)
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-wed-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Worship — Build My Life', 'CAM1: WL CU, CAM2: Band wide', 'Acoustic-led, intimate framing', '2026-03-18', '2026-03-18T07:00:00Z', '2026-03-18T07:00:00Z'),
  ('seed-cue-wed-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Teaching — Romans 8 (Part 2)', 'CAM1: Teacher CU, CAM2: Pulpit medium, PTZ: Wide', 'PP slides for discussion questions', '2026-03-18', '2026-03-18T07:00:00Z', '2026-03-18T07:00:00Z'),
  ('seed-cue-wed-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 3, 'Testimony', 'Full screen video playback', 'Pre-recorded — switch to video input at cue', '2026-03-18', '2026-03-18T07:00:00Z', '2026-03-18T07:00:00Z'),
  ('seed-cue-wed-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 4, 'Closing Song — 10,000 Reasons', 'CAM1: WL CU, CAM2: Congregation wide', 'Congregational singing — show crowd', '2026-03-18', '2026-03-18T07:00:00Z', '2026-03-18T07:00:00Z');

-- 2026-03-19 (Thursday Rehearsal)
INSERT OR IGNORE INTO cue_sheet (id, orgId, cueNumber, rundownItem, cameraAssignments, notes, serviceDate, createdAt, updatedAt)
VALUES
  ('seed-cue-thu-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 1, 'Camera Blocking', 'All cameras', 'Walk through every shot for Sunday — mark positions', '2026-03-19', '2026-03-19T07:00:00Z', '2026-03-19T07:00:00Z'),
  ('seed-cue-thu-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 2, 'Full Run-Through', 'CAM1, CAM2, PTZ — full Sunday assignments', 'Simulate full Sunday service — practice all transitions', '2026-03-19', '2026-03-19T07:00:00Z', '2026-03-19T07:00:00Z');

-- ═══════════════════════════════════════════════════════════════
-- CHECKLIST ENTRIES — 2026-03-13 through 2026-03-19
-- Templates: seed-cl-01 through seed-cl-13
-- ═══════════════════════════════════════════════════════════════

-- 2026-03-13 (Friday) — most items checked
INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, serviceDate, checked, checkedBy, checkedAt)
VALUES
  ('seed-ce-fri-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-01', '2026-03-13', 1, 'Sarah Osei', '2026-03-13T17:30:00Z'),
  ('seed-ce-fri-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-02', '2026-03-13', 1, 'Sarah Osei', '2026-03-13T17:32:00Z'),
  ('seed-ce-fri-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-03', '2026-03-13', 1, 'Sarah Osei', '2026-03-13T17:35:00Z'),
  ('seed-ce-fri-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-04', '2026-03-13', 0, NULL, NULL),
  ('seed-ce-fri-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-05', '2026-03-13', 1, 'Priscilla Asante', '2026-03-13T17:40:00Z'),
  ('seed-ce-fri-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-06', '2026-03-13', 1, 'Priscilla Asante', '2026-03-13T17:42:00Z'),
  ('seed-ce-fri-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-07', '2026-03-13', 1, 'Daniel Appiah', '2026-03-13T17:38:00Z'),
  ('seed-ce-fri-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-08', '2026-03-13', 1, 'Kwame Boateng', '2026-03-13T17:45:00Z'),
  ('seed-ce-fri-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-09', '2026-03-13', 1, 'Kwame Boateng', '2026-03-13T17:48:00Z'),
  ('seed-ce-fri-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-10', '2026-03-13', 1, 'Emmanuel Tetteh', '2026-03-13T17:50:00Z'),
  ('seed-ce-fri-11', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-11', '2026-03-13', 0, NULL, NULL),
  ('seed-ce-fri-12', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-12', '2026-03-13', 1, 'Esi Mensah', '2026-03-13T17:55:00Z'),
  ('seed-ce-fri-13', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-13', '2026-03-13', 1, 'James Mensah', '2026-03-13T18:00:00Z');

-- 2026-03-14 (Saturday Youth Night)
INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, serviceDate, checked, checkedBy, checkedAt)
VALUES
  ('seed-ce-sat-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-01', '2026-03-14', 1, 'Sarah Osei', '2026-03-14T16:00:00Z'),
  ('seed-ce-sat-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-02', '2026-03-14', 1, 'Sarah Osei', '2026-03-14T16:02:00Z'),
  ('seed-ce-sat-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-03', '2026-03-14', 1, 'Sarah Osei', '2026-03-14T16:05:00Z'),
  ('seed-ce-sat-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-04', '2026-03-14', 1, 'Sarah Osei', '2026-03-14T16:08:00Z'),
  ('seed-ce-sat-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-05', '2026-03-14', 1, 'Priscilla Asante', '2026-03-14T16:10:00Z'),
  ('seed-ce-sat-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-06', '2026-03-14', 0, NULL, NULL),
  ('seed-ce-sat-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-07', '2026-03-14', 1, 'Daniel Appiah', '2026-03-14T16:15:00Z'),
  ('seed-ce-sat-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-08', '2026-03-14', 1, 'Kwame Boateng', '2026-03-14T16:18:00Z'),
  ('seed-ce-sat-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-09', '2026-03-14', 1, 'Kwame Boateng', '2026-03-14T16:20:00Z'),
  ('seed-ce-sat-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-10', '2026-03-14', 1, 'Emmanuel Tetteh', '2026-03-14T16:22:00Z'),
  ('seed-ce-sat-11', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-11', '2026-03-14', 1, 'Emmanuel Tetteh', '2026-03-14T16:25:00Z'),
  ('seed-ce-sat-12', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-12', '2026-03-14', 1, 'Esi Mensah', '2026-03-14T16:28:00Z'),
  ('seed-ce-sat-13', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-13', '2026-03-14', 0, NULL, NULL);

-- 2026-03-15 (Sunday Morning) — all checked, full prep
INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, serviceDate, checked, checkedBy, checkedAt)
VALUES
  ('seed-ce-sun-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-01', '2026-03-15', 1, 'Sarah Osei', '2026-03-15T07:30:00Z'),
  ('seed-ce-sun-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-02', '2026-03-15', 1, 'Sarah Osei', '2026-03-15T07:32:00Z'),
  ('seed-ce-sun-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-03', '2026-03-15', 1, 'Sarah Osei', '2026-03-15T07:35:00Z'),
  ('seed-ce-sun-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-04', '2026-03-15', 1, 'Sarah Osei', '2026-03-15T07:38:00Z'),
  ('seed-ce-sun-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-05', '2026-03-15', 1, 'Priscilla Asante', '2026-03-15T07:40:00Z'),
  ('seed-ce-sun-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-06', '2026-03-15', 1, 'Priscilla Asante', '2026-03-15T07:42:00Z'),
  ('seed-ce-sun-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-07', '2026-03-15', 1, 'Daniel Appiah', '2026-03-15T07:45:00Z'),
  ('seed-ce-sun-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-08', '2026-03-15', 1, 'Kwame Boateng', '2026-03-15T07:48:00Z'),
  ('seed-ce-sun-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-09', '2026-03-15', 1, 'Kwame Boateng', '2026-03-15T07:50:00Z'),
  ('seed-ce-sun-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-10', '2026-03-15', 1, 'Emmanuel Tetteh', '2026-03-15T07:52:00Z'),
  ('seed-ce-sun-11', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-11', '2026-03-15', 1, 'Emmanuel Tetteh', '2026-03-15T07:55:00Z'),
  ('seed-ce-sun-12', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-12', '2026-03-15', 1, 'Esi Mensah', '2026-03-15T07:58:00Z'),
  ('seed-ce-sun-13', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-13', '2026-03-15', 1, 'James Mensah', '2026-03-15T08:00:00Z');

-- 2026-03-16 (Monday Bible Study) — minimal crew, fewer items checked
INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, serviceDate, checked, checkedBy, checkedAt)
VALUES
  ('seed-ce-mon-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-01', '2026-03-16', 1, 'Sarah Osei', '2026-03-16T18:00:00Z'),
  ('seed-ce-mon-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-03', '2026-03-16', 1, 'Sarah Osei', '2026-03-16T18:05:00Z'),
  ('seed-ce-mon-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-05', '2026-03-16', 0, NULL, NULL),
  ('seed-ce-mon-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-07', '2026-03-16', 1, 'Daniel Appiah', '2026-03-16T18:10:00Z'),
  ('seed-ce-mon-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-09', '2026-03-16', 1, 'Kwame Boateng', '2026-03-16T18:12:00Z'),
  ('seed-ce-mon-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-13', '2026-03-16', 1, 'James Mensah', '2026-03-16T18:15:00Z');

-- 2026-03-17 (Tuesday Prayer Night) — minimal crew
INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, serviceDate, checked, checkedBy, checkedAt)
VALUES
  ('seed-ce-tue-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-01', '2026-03-17', 1, 'Sarah Osei', '2026-03-17T18:00:00Z'),
  ('seed-ce-tue-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-03', '2026-03-17', 1, 'Sarah Osei', '2026-03-17T18:05:00Z'),
  ('seed-ce-tue-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-07', '2026-03-17', 1, 'Daniel Appiah', '2026-03-17T18:08:00Z'),
  ('seed-ce-tue-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-09', '2026-03-17', 1, 'Kwame Boateng', '2026-03-17T18:10:00Z'),
  ('seed-ce-tue-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-10', '2026-03-17', 1, 'Emmanuel Tetteh', '2026-03-17T18:12:00Z'),
  ('seed-ce-tue-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-13', '2026-03-17', 0, NULL, NULL);

-- 2026-03-18 (Wednesday Midweek)
INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, serviceDate, checked, checkedBy, checkedAt)
VALUES
  ('seed-ce-wed-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-01', '2026-03-18', 1, 'Sarah Osei', '2026-03-18T17:30:00Z'),
  ('seed-ce-wed-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-02', '2026-03-18', 1, 'Sarah Osei', '2026-03-18T17:32:00Z'),
  ('seed-ce-wed-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-03', '2026-03-18', 1, 'Sarah Osei', '2026-03-18T17:35:00Z'),
  ('seed-ce-wed-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-04', '2026-03-18', 0, NULL, NULL),
  ('seed-ce-wed-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-05', '2026-03-18', 1, 'Priscilla Asante', '2026-03-18T17:40:00Z'),
  ('seed-ce-wed-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-06', '2026-03-18', 1, 'Priscilla Asante', '2026-03-18T17:42:00Z'),
  ('seed-ce-wed-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-07', '2026-03-18', 1, 'Daniel Appiah', '2026-03-18T17:45:00Z'),
  ('seed-ce-wed-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-08', '2026-03-18', 1, 'Kwame Boateng', '2026-03-18T17:48:00Z'),
  ('seed-ce-wed-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-09', '2026-03-18', 1, 'Kwame Boateng', '2026-03-18T17:50:00Z'),
  ('seed-ce-wed-10', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-10', '2026-03-18', 1, 'Emmanuel Tetteh', '2026-03-18T17:52:00Z'),
  ('seed-ce-wed-11', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-11', '2026-03-18', 1, 'Emmanuel Tetteh', '2026-03-18T17:55:00Z'),
  ('seed-ce-wed-12', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-12', '2026-03-18', 1, 'Esi Mensah', '2026-03-18T17:58:00Z'),
  ('seed-ce-wed-13', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-13', '2026-03-18', 1, 'James Mensah', '2026-03-18T18:00:00Z');

-- 2026-03-19 (Thursday Rehearsal) — tech-focused items only
INSERT OR IGNORE INTO checklist_entry (id, orgId, templateId, serviceDate, checked, checkedBy, checkedAt)
VALUES
  ('seed-ce-thu-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-01', '2026-03-19', 1, 'Sarah Osei', '2026-03-19T17:00:00Z'),
  ('seed-ce-thu-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-02', '2026-03-19', 1, 'Sarah Osei', '2026-03-19T17:02:00Z'),
  ('seed-ce-thu-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-03', '2026-03-19', 1, 'Sarah Osei', '2026-03-19T17:05:00Z'),
  ('seed-ce-thu-04', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-04', '2026-03-19', 1, 'Sarah Osei', '2026-03-19T17:08:00Z'),
  ('seed-ce-thu-05', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-07', '2026-03-19', 1, 'Daniel Appiah', '2026-03-19T17:10:00Z'),
  ('seed-ce-thu-06', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-08', '2026-03-19', 1, 'Kwame Boateng', '2026-03-19T17:12:00Z'),
  ('seed-ce-thu-07', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-09', '2026-03-19', 1, 'Kwame Boateng', '2026-03-19T17:15:00Z'),
  ('seed-ce-thu-08', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-10', '2026-03-19', 1, 'Emmanuel Tetteh', '2026-03-19T17:18:00Z'),
  ('seed-ce-thu-09', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'seed-cl-11', '2026-03-19', 1, 'Emmanuel Tetteh', '2026-03-19T17:20:00Z');

-- ═══════════════════════════════════════════════════════════════
-- INCIDENTS — realistic production incidents across the week
-- ═══════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO incident (id, orgId, category, severity, description, reportedBy, serviceDate, timestamp)
VALUES
  -- Friday
  ('seed-inc-fri-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'audio', 'medium', 'Wireless mic 2 dropped signal during praise set — switched to backup handheld mid-song', 'Sarah Osei', '2026-03-13', '2026-03-13T19:15:00Z'),
  ('seed-inc-fri-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'video', 'low', 'PTZ camera preset 3 was off by 2 degrees — corrected during worship', 'Daniel Appiah', '2026-03-13', '2026-03-13T19:25:00Z'),

  -- Saturday
  ('seed-inc-sat-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'streaming', 'high', 'YouTube stream dropped for 45 seconds during message — encoder reconnected automatically', 'Priscilla Asante', '2026-03-14', '2026-03-14T18:40:00Z'),
  ('seed-inc-sat-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'lighting', 'low', 'House lights preset triggered early during small group breakout — manually corrected', 'Emmanuel Tetteh', '2026-03-14', '2026-03-14T19:10:00Z'),

  -- Sunday
  ('seed-inc-sun-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'audio', 'high', 'FOH console froze during choir anthem — had to power cycle. 20 second gap in audio', 'Sarah Osei', '2026-03-15', '2026-03-15T10:15:00Z'),
  ('seed-inc-sun-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'video', 'medium', 'Wrong sermon slide advanced during scripture reading — graphics operator corrected within 3 seconds', 'Kwame Boateng', '2026-03-15', '2026-03-15T10:35:00Z'),
  ('seed-inc-sun-03', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'general', 'low', 'Late start — service began 4 minutes late due to delayed prayer team arrival', 'Nana Ama', '2026-03-15', '2026-03-15T09:34:00Z'),

  -- Monday (none — small event)

  -- Tuesday
  ('seed-inc-tue-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'lighting', 'medium', 'Stage wash lights flickering during corporate prayer — loose DMX cable found and reseated', 'Emmanuel Tetteh', '2026-03-17', '2026-03-17T19:30:00Z'),

  -- Wednesday
  ('seed-inc-wed-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'video', 'high', 'Pre-recorded testimony video had no audio for first 8 seconds — file encoding issue', 'Kwame Boateng', '2026-03-18', '2026-03-18T19:45:00Z'),
  ('seed-inc-wed-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'audio', 'low', 'Slight feedback during closing song — EQ notch filter applied at 2.5kHz', 'Sarah Osei', '2026-03-18', '2026-03-18T20:00:00Z'),

  -- Thursday Rehearsal
  ('seed-inc-thu-01', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'video', 'medium', 'Camera 2 tripod plate loose — tightened before run-through. Needs replacement plate ordered', 'Daniel Appiah', '2026-03-19', '2026-03-19T17:30:00Z'),
  ('seed-inc-thu-02', 'mSWw5eFybxBYl6C2QehWEc55SZ6PBP7x', 'comms', 'low', 'Comms channel 2 had static — battery swap fixed it', 'Esi Mensah', '2026-03-19', '2026-03-19T18:00:00Z');

-- Done!
-- Login: mahali@test.com (use the password you set during signup)
-- Org slug: grace-church
-- URL: http://localhost:3000/grace-church
