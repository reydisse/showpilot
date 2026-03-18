# ShowPilot v3 — Claude Code Master Prompt (Final)

─────────────────────────────────────────
CRITICAL INSTRUCTIONS — READ FIRST
─────────────────────────────────────────

1. BRANCH FIRST
   Before touching any code, create a new git branch:
   git checkout -b feature/showpilot-integrations-v3
   All work happens on this branch only.
   Do not touch main or any existing branch.
   Commit regularly with descriptive messages as you build each feature.
1. ADDITIVE ONLY — DO NOT BREAK EXISTING CODE
   This codebase is live and in active deployment.
   You are ADDING new features, not rewriting the application.
   
   Rules:
- Read the existing codebase structure before writing a single line
- Understand existing patterns (routing, auth, state, components)
  and match them exactly
- Never delete or modify existing files unless a specific file
  needs direct extension for a new feature
- If you need to modify an existing file, add to it — do not
  replace existing logic
- New components go in new files
- New routes are additive — do not touch existing routes
- New Firestore collections do not affect existing collections
- New Durable Objects are independent — do not modify existing ones
- If anything feels like it requires breaking changes, STOP and
  flag it with a comment rather than proceeding
1. BEFORE WRITING ANY CODE
- Run: git status (confirm clean working tree)
- Read the existing folder structure
- Read existing auth, routing, and state management patterns
- Match everything you build to what already exists

─────────────────────────────────────────
WHAT IS SHOWPILOT
─────────────────────────────────────────
ShowPilot is a cloud-native live production management platform built
for faith communities and live event organizations. It is part of a
three-product ecosystem:

ShowPilot   — production management platform (this codebase)
FreeCom     — browser-based WebRTC party-line intercom (separate repo)
OpenClaw    — AI agent for production automation (separate repo)

FreeCom and OpenClaw will be integrated into ShowPilot later.
Do not build those integrations now. Leave clean placeholder hooks
and disabled UI cards in settings only.

ShowPilot’s core philosophy:

“Bring your own stack — ShowPilot connects to it.
No stack? ShowPilot IS the stack — and it’s better.”

ShowPilot is an integration layer first, native fallback second.
Every feature checks whether the org has an external tool configured.
If yes, SP bridges to it. If no, SP’s native feature activates —
and the native feature must be functionally equivalent to or better
than the external tool it replaces.

This is a production tool used by real operators during live church
services. Every design and engineering decision must reflect that —
clarity over beauty, speed over cleverness, zero ambiguity under pressure.

─────────────────────────────────────────
REFERENCE STANDARD
─────────────────────────────────────────
The UI/UX benchmark for ShowPilot’s native features is OnTime
(getontime.dev) — a professional broadcast rundown and timer
application used in live television and events.

SP’s native features must be functionally equivalent to their
external counterparts but built in SP’s own design language.
Do not clone OnTime’s UI — match its operational depth and
reliability in SP’s broadcast-dark aesthetic.

─────────────────────────────────────────
TECH STACK
─────────────────────────────────────────

- Backend:     Cloudflare Workers (NO Node.js server)
- Realtime:    Cloudflare Durable Objects (WebSocket state per org)
- Database:    Firestore scoped by orgId (multi-tenant)
- Auth:        Firebase custom claims + orgId scoping
- Frontend:    React (existing codebase)
- Styling:     Tailwind CSS
- Deployment:  Cloudflare Pages (frontend) + Workers (backend)
- Users:       Church production operators, AV technicians, directors

─────────────────────────────────────────
MULTI-TENANCY RULES
─────────────────────────────────────────
Every route, Durable Object room, Firestore collection, and WebSocket
connection is scoped by orgId. No org can see or affect another org’s
data. Firebase custom claims carry orgId and role. Enforce everywhere.

─────────────────────────────────────────
INTEGRATION ARCHITECTURE
─────────────────────────────────────────
ShowPilot uses an adapter pattern for all integrations. Each feature
(chat, rundown, timer) has:

1. An integration adapter — connects to external tool
1. A native adapter — SP’s own implementation
1. A feature interface — the React UI, identical regardless of adapter

The Settings page is where orgs configure which adapter is active
per feature. The UI never changes based on which adapter is active —
only the data source changes.

Adapter resolution order:

1. Check org settings for configured integration
1. If configured and healthy → use integration adapter
1. If not configured or unhealthy → fall back to native silently
1. Show connection status in settings only, never in operator UI

Integration adapter failures must fall back to native silently.
The operator UI stays clean no matter what breaks behind the scenes.

─────────────────────────────────────────────────────────────────
FEATURE 1: CHAT SYSTEM
─────────────────────────────────────────────────────────────────

── INTEGRATION ADAPTERS ──

When an org connects one of these, SP sends and receives via their
API. Chat lives in the external platform. SP is the interface inside
ShowPilot. Operators never need to leave SP to communicate.

Each adapter exposes the same interface:
sendMessage(text, type, senderName, senderRole)
onMessage(callback)
getHistory(limit)
connectionStatus()

Slack
Connect via Slack OAuth
Map a Slack channel to SP’s production chat
SP sends messages to Slack, receives via Slack Events API
Incoming Slack messages appear in SP’s chat panel in real time

Mattermost  ← PRIMARY REAL-WORLD CASE (Faithfire uses this)
Connect via Mattermost bot token + server URL
Map a Mattermost channel to SP’s production chat
SP sends/receives via Mattermost WebSocket API

Microsoft Teams
Connect via Teams bot + webhook
Map a Teams channel
Send/receive via Teams Graph API

Discord
Connect via Discord bot token
Map a Discord channel
Send/receive via Discord Gateway WebSocket

── NATIVE CHAT (fallback) ──

Activated when no external chat is configured.
Must be functionally equivalent to Slack for production use.

Durable Object: ChatRelay

- One instance per orgId
- WebSocket room for real-time delivery
- Stores last 200 messages in memory for hydration
- Persists to Firestore async (non-blocking)

Firestore: orgs/{orgId}/chat/{messageId}
Fields: id, orgId, senderId, senderName, senderRole,
text, type, timestamp, readBy[]

Message types:
text    — standard message, white text
alert   — high visibility, red background, pinned 10s
cue     — production callout, amber, monospace “[CUE] Camera 2 wide”
system  — automated SP events, muted italic

── CHAT UI (same regardless of adapter) ──

Chat Panel (collapsible sidebar):

- Dark broadcast aesthetic
- Sender name + role badge + timestamp per message
- Visual distinction per message type
- Input bar — Enter to send, Shift+Enter for newline
- Unread badge on toggle button
- Role badges: TD, Audio, Camera, Director, Operator

Compact mode (always visible in SP header):

- Last 3 messages inline — operator stays aware without opening panel
- Unread count badge

─────────────────────────────────────────────────────────────────
FEATURE 2: RUNDOWN & TIMER
─────────────────────────────────────────────────────────────────

── INTEGRATION ADAPTERS ──

OnTime
Connect via OnTime API (REST + WebSocket)
SP becomes a full control surface for OnTime
Operators can start, stop, pause, roll, and adjust timers
from within SP without touching OnTime directly
SP displays OnTime’s rundown inside its own UI
Bi-directional sync — changes in OnTime reflect in SP and vice versa

```
Toggleable in settings:
  [ ] Sync rundown from OnTime  (default: on)
  [ ] Allow SP to send commands to OnTime  (default: on)
```

ProPresenter
Connect via ProPresenter Network Link (port 50001) or Pro7 API
SP pulls service order / presentation list from PP
SP can optionally push cues back to PP:
- Advance slide
- Previous slide
- Trigger a specific presentation by name/index
- Clear to logo

```
Toggleable in settings:
  [ ] Pull service order from ProPresenter  (default: on)
  [ ] Allow SP to send cues to ProPresenter  (default: OFF)
      ⚠ Warning: "This gives ShowPilot control over your
        ProPresenter. Only enable if your TD is aware."
```

Planning Center
Connect via Planning Center OAuth + Services API
Pull service plan items into SP runsheet
Sync person assignments, song order, notes
Read-only — SP does not push to Planning Center
Auto-refresh before service (configurable: 15 / 30 / 60 min)

── NATIVE RUNDOWN (fallback) ──

Activated when no external rundown tool is configured.
Must be functionally equivalent to OnTime for live production use.

Features:

- Runsheet builder: add, reorder, group items via drag and drop
- Per-item fields: title, type, duration, notes, assignee, cue
- Item types: segment, song, prayer, announcement, offering, custom
- Global timer: counts up or down, configurable per item
- Per-item timer: auto-advances to next item on completion
- Elapsed / remaining display modes
- Overtime indicator (red) when item exceeds duration
- Hard stop vs soft stop per item
- Notes/script field per item (visible to assigned operator only)
- Multi-operator view: all connected operators see live runsheet state

Durable Object: RundownRelay

- One instance per orgId
- Broadcasts runsheet state to all connected operators
- Stores current runsheet state for hydration

── RUNDOWN UI (same regardless of adapter) ──

- Full runsheet list: upcoming / live / complete per item
- Current item highlighted — unmissable at a glance
- Timer display: large, readable from across the room
- Next item preview
- Drag to reorder (disabled when live)
- Keyboard shortcuts for all timer controls
- Operator notes visible inline for assigned items
- Lower third attachment per item (see Feature 3)

─────────────────────────────────────────────────────────────────
FEATURE 3: LOWER THIRDS
─────────────────────────────────────────────────────────────────

Lower thirds are always SP-native — no external adapter.
SP pushes to OBS and vMix regardless of other integrations.

── DATA MODEL (Firestore) ──

Collection: orgs/{orgId}/lowerthirds/{id}
Fields: id, orgId, label, type, name, title, scripture,
translation, line1, line2, style, state,
triggeredBy, triggeredAt, updatedAt

State enum: idle | live | clearing

── TRIGGER TYPES ──

Type-aware forms — show only relevant fields. No blank inputs ever.

person      Name + Title/Role
Example: “Pastor James Mensah — Lead Pastor”

scripture   Reference + Translation
Example: “John 3:16 — NIV”

freetext    Line 1 + Line 2 (optional)
Example: “Youth Conference — Register at Welcome Desk”

style       Style/theme switch only (no content change)
Use: switch overlay appearance mid-show

── BACKEND ──

Durable Object: LowerThirdsRelay

- One per orgId
- WebSocket room
- Broadcasts: { action: “show” | “clear” | “style”, payload }
- Stores last state — late connectors hydrate instantly
- Handles reconnection gracefully

Worker routes:
POST /api/lowerthirds/:orgId/trigger
POST /api/lowerthirds/:orgId/clear
POST /api/lowerthirds/:orgId/queue
GET  /api/lowerthirds/:orgId/ws
GET  /api/lowerthirds/:orgId/current

── OPERATOR UI ──

Dedicated Lower Thirds Panel (/lowerthirds):

- Saved library per org
- Type-aware create / edit / delete forms
- One-click PUSH and CLEAR per row
- Live indicator: glowing accent, full row color shift when active
- Queue slot: next lower third preloaded
- Preview pane: shows render before pushing
- One-shot trigger: fire without saving to library
- Operator never more than one click from push or clear

Runsheet Integration:

- Each runsheet item has optional attached lower third
- Inline: [L3 badge] [type icon] [label] [PUSH] [CLEAR]
- Live state indicator in runsheet row
- Consistent state via shared WebSocket

── OVERLAY RENDERER ──

File: overlay.html — self-contained, zero dependencies, zero build step
URL: https://[workers-domain]/overlay/:orgId?style=default

Requirements:

- Transparent background — chroma-key ready
- Connects to LowerThirdsRelay WebSocket on load
- Hydrates from /current on load
- Auto-reconnects on drop
- Renders in under 300ms from trigger
- Works at 5Mbps church internet
- Pure HTML/CSS/JS only — no React, no npm, no frameworks

Style variants (?style=):
default    white text, dark semi-transparent bar, lower-left
minimal    name only, thin accent line, no fill
scripture  centered, larger text, Bible reference optimized

Animations:
Show:  slide up + fade in  (200ms)
Clear: fade out + slide down  (300ms)

Compatible with:

- OBS Browser Source
- vMix Browser Input
- Any software with browser source capability

─────────────────────────────────────────────────────────────────
FEATURE 4: SETTINGS PAGE
─────────────────────────────────────────────────────────────────

The settings page is the integration hub. Orgs configure which
external tools they use and turn SP’s native fallbacks on or off.

Route: /settings
Layout: Left sidebar nav, each section is a full page
Save: Auto-save with subtle toast confirmation
Destructive actions: require typing the org name to confirm
Integration connection flows: open in modal, not new tab

── SECTIONS ──

ORGANIZATION
Org name, logo upload, timezone, default language, org slug
Subscription/plan info (display only)

TEAM & ROLES
Member list with role badges
Invite new member by email
Roles: Admin, Technical Director, Operator, Viewer
Remove member
Pending invites with resend / cancel

INTEGRATIONS  ← most important section
This is the control center for the adapter system.

Chat Integration
Options: None (SP native) / Slack / Mattermost / Teams / Discord
Per option: connect button, auth/credential flow, channel selector
Connection status: Connected / Disconnected / Error
Test connection button

Rundown & Timer Integration
Options: None (SP native) / OnTime / ProPresenter / Planning Center
Per option: connect button, credential/URL fields

```
OnTime (when connected):
  [ ] Sync rundown from OnTime
  [ ] Allow SP to send commands to OnTime

ProPresenter (when connected):
  [ ] Pull service order from ProPresenter
  [ ] Allow SP to send cues to ProPresenter
      ⚠ Warning shown when enabling cue push

Planning Center (when connected):
  [ ] Auto-sync service plan
  Auto-refresh interval: 15 / 30 / 60 min
```

Future Integrations (placeholder — not built yet):
FreeCom — SP native intercom  [Coming Soon]
OpenClaw — AI production agent  [Coming Soon]
Disabled connect buttons, clean placeholder cards

PRODUCTION DEFAULTS
Default runsheet template
Default countdown timer settings
Default lower third style
Auto-clear lower thirds: toggle + duration (seconds)
Clock display: 12hr / 24hr
Timezone display preference

LOWER THIRDS
Default style selector (default / minimal / scripture)
Animation speed: fast / normal / slow
Auto-clear toggle + duration
Overlay URL generator:
Full URL for OBS/vMix
Copy button
QR code for mobile scanning
OBS setup instructions (collapsible)
vMix setup instructions (collapsible)

NOTIFICATIONS
Email notification preferences
In-app alert preferences
Chat alert sound toggle + volume

API & WEBHOOKS
API key display + regenerate button
Webhook URL field (for external triggers)
Event log: last 50 webhook events

DANGER ZONE
Reset all lower thirds
Clear chat history
Export org data
Delete organization (typed org name confirmation required)

─────────────────────────────────────────────────────────────────
GLOBAL UI/UX RULES
─────────────────────────────────────────────────────────────────

1. BROADCAST FIRST
   Operators use this during live services. No spinners blocking
   critical actions. No confirmation modals for non-destructive
   actions. No mystery states. Ever.
1. STATE IS ALWAYS VISIBLE
   Live / next / idle — always clear at a glance. Use color,
   iconography, and typography together. Never color alone.
1. OPTIMISTIC UI
   All actions update UI instantly. Confirm or revert via WebSocket.
   Never wait for a network round-trip before reflecting an action.
1. DARK THEME ONLY
   Operators work in dark production booths.
   Dark background (#0D0D0D or similar), high contrast text,
   accent color for live/active states.
1. KEYBOARD SHORTCUTS
   All critical actions have keyboard shortcuts.
   ? key opens help overlay with full shortcut reference.
1. MULTI-DEVICE
   MacBook (primary), iPad (secondary/roaming), Windows laptop.
   Responsive and touch-friendly without sacrificing desktop density.
1. WEBSOCKET RESILIENCE
   All WebSocket connections must:
- Reconnect with exponential backoff
- Show subtle connection status indicator (not intrusive)
- Queue outgoing messages during disconnection, flush on reconnect
- Never lose operator-initiated actions silently
1. INTEGRATION TRANSPARENCY
   The operator UI never exposes which adapter is active.
   Settings page shows integration status.
   Operator view is always clean.
1. NATIVE = BETTER
   SP’s native fallbacks are not consolation prizes. They must be
   functionally equivalent to or better than the external tools
   they replace. Build them to that standard.

─────────────────────────────────────────────────────────────────
DELIVERABLES
─────────────────────────────────────────────────────────────────

Backend:
[ ] LowerThirdsRelay Durable Object
[ ] ChatRelay Durable Object (native chat)
[ ] RundownRelay Durable Object (native rundown)
[ ] All Worker routes (additive to existing wrangler.toml)
[ ] Chat adapter interface + Slack, Mattermost, Teams, Discord adapters
[ ] Rundown adapter interface + OnTime, ProPresenter, Planning Center adapters
[ ] Firestore security rules for all new collections

Frontend (React):
[ ] ChatPanel.jsx + useChat.js
[ ] ChatCompact.jsx (inline header preview)
[ ] RundownPanel.jsx + useRundown.js
[ ] LowerThirdsPanel.jsx + useLowerThirds.js
[ ] LowerThirdControl.jsx (inline runsheet component)
[ ] SettingsPage.jsx with all sections and sub-components
[ ] IntegrationCard.jsx (reusable per integration)

Overlay:
[ ] overlay.html (self-contained, 3 style variants)

Documentation:
[ ] README: integration setup per tool (Slack, Mattermost, OnTime, PP, PCO)
[ ] README: overlay setup for OBS and vMix
[ ] README: keyboard shortcuts reference
[ ] README: WebSocket event schema for external integrations

─────────────────────────────────────────────────────────────────
CONSTRAINTS
─────────────────────────────────────────────────────────────────

- No Node.js server — Cloudflare Workers only
- Overlay must be pure HTML/JS — no build step, no frameworks
- All WebSocket connections handle drops gracefully
- Latency target: operator action → all clients updated in < 300ms
- Must work on 5Mbps church internet
- Multi-tenant: orgId scoping is non-negotiable everywhere
- Firestore writes are async and non-blocking for realtime paths
- All destructive actions require explicit confirmation
- FreeCom and OpenClaw: placeholder cards only, no integration built yet
- ProPresenter cue pushing is OFF by default — opt-in with warning
- Integration adapter failures fall back to native silently
- Operator UI never exposes adapter internals or error states
- Everything built on this branch: feature/showpilot-integrations-v3