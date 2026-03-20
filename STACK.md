# ShowPilot Technology Stack

Complete inventory of every service, library, framework, and infrastructure tool used in ShowPilot, based entirely on evidence found in the codebase.

---

## React
**Category:** Frontend Framework
**What it is:** A JavaScript UI library for building component-based interfaces.
**How ShowPilot uses it:** Core rendering engine for the entire frontend. Every page, component, and view is a React component. Version 19.2.0 with Server Components support used for SSR via TanStack Start. Entry point in `apps/web/src/routes/__root.tsx`.
**Why we chose it:** React 19's concurrent features (Suspense, transitions) align with ShowPilot's need for non-blocking UI during live production. The ecosystem is the largest of any frontend framework, meaning every integration (Radix, Framer Motion, TanStack) is React-first.
**Alternatives considered:** Svelte, SolidJS, Vue
**Why alternatives were rejected:** Svelte and SolidJS have smaller ecosystems — fewer production-grade UI component libraries (no Radix equivalent). Vue's composition API is viable but the TanStack Router/Start ecosystem is React-native. React 19's SSR streaming is critical for Cloudflare Workers edge rendering.

---

## TanStack Start
**Category:** Full-Stack Metaframework
**What it is:** A full-stack React metaframework from the TanStack ecosystem providing SSR, server functions, and file-based routing.
**How ShowPilot uses it:** Provides the entire application shell — SSR rendering, `createServerFn()` for all backend calls (see `apps/web/src/lib/session.ts`, `apps/web/src/lib/rundown.ts`), file-based route generation (`apps/web/src/routeTree.gen.ts`), and cookie-based session handling via the `tanstackStartCookies()` plugin in `apps/web/src/lib/auth.ts`.
**Why we chose it:** First-class Cloudflare Workers support via `@cloudflare/vite-plugin`. Server functions run directly in Workers without a Node.js server. Type-safe routing with automatic route tree generation. Unlike Next.js, it doesn't assume Node.js runtime.
**Alternatives considered:** Next.js, Remix, Astro, SvelteKit
**Why alternatives were rejected:** Next.js requires Node.js runtime — incompatible with Cloudflare Workers without heavy adaptation. Remix's Cloudflare support exists but TanStack offers tighter type safety with its router. Astro is content-focused, not app-focused. SvelteKit would require abandoning the React ecosystem.

---

## TanStack React Router
**Category:** Client-Side Routing
**What it is:** A fully type-safe React router with file-based route generation.
**How ShowPilot uses it:** All navigation, route guards (`beforeLoad` hooks), and layout nesting. Route files in `apps/web/src/routes/` are auto-discovered. Auth guards use `beforeLoad` to check sessions and redirect (see `apps/web/src/routes/$slug.tsx`, `apps/web/src/routes/_auth.tsx`). Pending states via `pendingComponent` on every route.
**Why we chose it:** Type-safe route params and search params. `beforeLoad` hooks enable server-side auth checks before rendering. `pendingComponent` gives instant loading feedback during data fetches — critical for a live production tool where blank screens are unacceptable.
**Alternatives considered:** React Router v7, wouter
**Why alternatives were rejected:** React Router lacks the type-safe route generation and `beforeLoad` pattern. wouter is too minimal for a multi-layout, auth-gated application.

---

## Cloudflare Workers
**Category:** Backend Runtime
**What it is:** A serverless JavaScript runtime that runs at Cloudflare's edge network.
**How ShowPilot uses it:** The entire backend. All server functions, API routes, and auth handlers run in Workers. Configured in `apps/web/wrangler.jsonc` with `nodejs_compat` flag. Entry point is `apps/web/src/server.ts`. Observability is enabled. Custom domain `showpilot.tech` is routed to the worker.
**Why we chose it:** Zero cold starts (V8 isolates, not containers). Global edge deployment means operators in any location get fast responses. No server management. Direct integration with D1, R2, and Durable Objects eliminates external service dependencies.
**Alternatives considered:** AWS Lambda, Vercel Functions, Fly.io, traditional VPS
**Why alternatives were rejected:** Lambda has cold start issues problematic for a real-time production tool. Vercel Functions are Node.js-based and less integrated with edge storage. Fly.io requires container management. A VPS requires ops overhead and doesn't scale globally.

---

## Cloudflare Durable Objects
**Category:** Real-Time State & WebSockets
**What it is:** Single-instance stateful objects that run on Cloudflare's edge, providing WebSocket support and in-memory state with SQLite persistence.
**How ShowPilot uses it:** Three Durable Object classes defined in `apps/web/wrangler.jsonc` and implemented in `apps/web/src/durable-objects/`:
- **ChatRelay** — WebSocket room per org for native chat. Stores last 200 messages in memory for hydration. Broadcasts to all connected operators.
- **RundownRelay** — Broadcasts rundown/timer state to all connected operators in real-time.
- **LowerThirdsRelay** — Broadcasts lower third trigger/clear/queue events. Late connectors hydrate from last state.
All three use SQLite persistence (migration tag `v1` in wrangler config).
**Why we chose it:** WebSocket support with guaranteed single-instance per org — no race conditions. In-memory state for sub-100ms broadcast latency. SQLite persistence means no external database needed for real-time data. Runs on the same Cloudflare network as Workers.
**Alternatives considered:** Supabase Realtime, Pusher, Ably, Socket.io on a VPS
**Why alternatives were rejected:** External WebSocket services add latency and a third-party dependency. Supabase Realtime requires PostgreSQL. Pusher/Ably add per-message costs. Socket.io requires a long-running server. Durable Objects are co-located with the rest of the infrastructure.

---

## Cloudflare D1
**Category:** Database
**What it is:** Cloudflare's serverless SQLite database, accessible from Workers.
**How ShowPilot uses it:** Primary database for all persistent data. Binding `DB` in `apps/web/wrangler.jsonc` (database ID: `2bdc2789-489e-44e7-85a1-652b8e2f133c`). Accessed via Prisma ORM with the D1 adapter in `apps/web/src/lib/db.ts`. Stores users, sessions, organizations, members, invitations, rundown items, chat messages, graphic templates, stream destinations, kiosk tokens, crew members, equipment, incidents, and more (21 models in `prisma/schema.prisma`).
**Why we chose it:** Zero-config SQLite on Cloudflare's network — no connection pooling, no cold connections. Read replicas at the edge for fast queries. Integrates directly with Workers via env bindings. Free tier is generous for church production teams.
**Alternatives considered:** Supabase (PostgreSQL), PlanetScale (MySQL), Turso (libSQL), Neon (PostgreSQL)
**Why alternatives were rejected:** External databases add network latency from Workers. Supabase and Neon require TCP connections incompatible with Workers without adapters. PlanetScale deprecated their free tier. Turso is viable but D1 is native to the Cloudflare ecosystem with tighter integration.

---

## Cloudflare R2
**Category:** Object Storage
**What it is:** Cloudflare's S3-compatible object storage with zero egress fees.
**How ShowPilot uses it:** Binding `STORAGE` in `apps/web/wrangler.jsonc` (bucket: `showpilot-storage`). Used for file uploads (org logos, assets).
**Why we chose it:** Zero egress fees — critical when serving assets to multiple operator devices during live services. S3-compatible API. Co-located with Workers for fast access. No separate CDN needed.
**Alternatives considered:** AWS S3, Backblaze B2, Supabase Storage
**Why alternatives were rejected:** S3 has egress costs that scale with usage. Backblaze B2 requires a separate CDN. Supabase Storage adds another third-party service. R2 is native to the stack.

---

## Cloudflare Stream
**Category:** Live Video Streaming
**What it is:** Cloudflare's live video streaming and simulcast service.
**How ShowPilot uses it:** Live input creation and multi-platform simulcast via Stream Connect. `apps/web/src/lib/stream.ts` manages live inputs (create, fetch status, track idle/connected/streaming states). `apps/web/src/lib/stream-destinations.ts` manages destinations (YouTube, Facebook, Twitch, custom RTMP). Uses Cloudflare API (`/client/v4/accounts/{id}/stream/live_inputs`) with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from environment.
**Why we chose it:** Native simulcast (Stream Connect) eliminates the need for a separate restreaming service. RTMPS + SRT ingest URLs generated automatically. Status tracking built into the API. Same billing account as the rest of the infrastructure.
**Alternatives considered:** Restream, Mux, AWS IVS, OBS direct multi-output
**Why alternatives were rejected:** Restream is a separate SaaS with per-channel pricing. Mux is primarily on-demand, not live-first. AWS IVS requires AWS infrastructure. OBS multi-output requires manual configuration per destination and doesn't scale to org-level management.

---

## Prisma
**Category:** ORM / Database Client
**What it is:** A TypeScript ORM with schema-first design, migrations, and type-safe queries.
**How ShowPilot uses it:** All database access goes through Prisma. Schema defined in `apps/web/prisma/schema.prisma` with SQLite provider and Cloudflare runtime. `apps/web/src/lib/db.ts` creates a per-request `PrismaClient` with the `PrismaD1` adapter. Used in every server function in `apps/web/src/lib/session.ts`, `apps/web/src/lib/rundown.ts`, `apps/web/src/lib/chat.ts`, etc. Generated client output to `apps/web/src/generated/prisma/client`.
**Why we chose it:** Type-safe database queries with auto-completion. Schema-first design with declarative migrations. Official D1 adapter (`@prisma/adapter-d1 ^7.0.0`). The generated types flow through the entire application — from database to API to UI.
**Alternatives considered:** Drizzle ORM, raw D1 SQL, Kysely
**Why alternatives were rejected:** Drizzle is lighter but lacks Prisma's migration tooling and ecosystem maturity. Raw SQL loses type safety. Kysely has no official D1 adapter. Prisma's D1 adapter is production-ready and the generated types reduce bugs significantly.

---

## Better Auth
**Category:** Authentication
**What it is:** A self-hosted, TypeScript-first authentication library with plugin support.
**How ShowPilot uses it:** Full auth system configured in `apps/web/src/lib/auth.ts`. Email/password authentication with password reset flow. Organization plugin for multi-tenancy with RBAC — 6 static roles (owner, admin, pm, tm, stageManager, member) defined in `apps/web/src/lib/permissions.ts`. Invitation system with email delivery. Dynamic access control with up to 20 custom roles per org. Client-side hooks via `apps/web/src/lib/auth-client.ts`. Session management with cookies via `tanstackStartCookies()` plugin.
**Why we chose it:** Self-hosted — no third-party auth service dependency. Works in Cloudflare Workers (no Node.js runtime requirement). Built-in organization/multi-tenancy plugin eliminates custom RBAC implementation. Prisma adapter for direct D1 integration. TypeScript-first with end-to-end type safety.
**Alternatives considered:** Clerk, Auth.js (NextAuth), Lucia Auth, Firebase Auth, Supabase Auth
**Why alternatives were rejected:** Clerk is a SaaS with per-user pricing — expensive for church teams. Auth.js is tied to Next.js patterns. Lucia Auth was deprecated. Firebase Auth requires Firebase SDK and doesn't integrate with D1. Supabase Auth requires Supabase infrastructure. Better Auth is the only self-hosted option with a built-in organization plugin and Cloudflare Workers compatibility.

---

## Resend
**Category:** Transactional Email
**What it is:** A developer-first email API for sending transactional emails.
**How ShowPilot uses it:** Sends password reset and team invitation emails. `apps/web/src/lib/email.ts` calls the Resend REST API (`https://api.resend.com/emails`) with branded HTML templates. Sends from `noreply@showpilot.tech`. `RESEND_API_KEY` stored as a Cloudflare secret. Graceful fallback — logs warning if key not set, throws on send failure.
**Why we chose it:** Simple REST API that works from Cloudflare Workers (no SDK needed, just `fetch`). Developer-friendly dashboard. Domain verification is straightforward. Free tier covers church production team volumes.
**Alternatives considered:** SendGrid, AWS SES, Postmark, Mailgun
**Why alternatives were rejected:** SendGrid's API is more complex and the free tier is shrinking. AWS SES requires AWS credentials and IAM setup. Postmark is reliable but more expensive for low volume. Mailgun's free tier is limited. Resend's REST-only approach is the simplest to use from Workers.

---

## Tailwind CSS
**Category:** CSS Framework
**What it is:** A utility-first CSS framework.
**How ShowPilot uses it:** All styling across the application. Version 4.1.18 with Vite plugin (`@tailwindcss/vite`). Custom design tokens defined in `apps/web/src/styles.css` using CSS variables — fire palette (`fire-500` through `fire-700`), board tokens (`board-bg`, `board-card`, `board-border`, `board-text`, `board-muted`). Dark/light theme support via `.dark` class with OKLCH color space. Custom utilities: `hide-scrollbar`, `modern-scrollbar`. Animation extension via `tw-animate-css`.
**Why we chose it:** Utility-first approach means components are styled inline — no CSS file management. Dark theme is trivial with CSS variables. Tailwind v4's Vite plugin eliminates PostCSS configuration. The broadcast-dark aesthetic is easy to build with utility classes.
**Alternatives considered:** CSS Modules, styled-components, vanilla-extract, UnoCSS
**Why alternatives were rejected:** CSS Modules require separate files per component. styled-components adds runtime overhead. vanilla-extract requires build-time extraction setup. UnoCSS is viable but has a smaller ecosystem and fewer UI libraries built on it.

---

## Radix UI
**Category:** Headless UI Components
**What it is:** A set of unstyled, accessible UI primitives for React.
**How ShowPilot uses it:** Foundation for all interactive UI components. `radix-ui ^1.4.3` provides Dialog, Tabs, Label, Tooltip, Select, Dropdown Menu, Separator, and more. Components in `apps/web/src/components/ui/` wrap Radix primitives with Tailwind styling. Configured via shadcn in `apps/web/components.json`.
**Why we chose it:** Fully accessible out of the box (ARIA, keyboard navigation). Unstyled — pairs perfectly with Tailwind. Used via shadcn/ui which provides pre-styled Radix components matching ShowPilot's dark aesthetic.
**Alternatives considered:** Headless UI (Tailwind Labs), Ark UI, React Aria
**Why alternatives were rejected:** Headless UI has fewer primitives (no Tabs, no Tooltip). Ark UI is newer with less community adoption. React Aria is lower-level and requires more boilerplate. Radix + shadcn gives the best balance of accessibility, customization, and developer speed.

---

## shadcn/ui
**Category:** Component Library
**What it is:** A collection of copy-paste React components built on Radix UI and Tailwind CSS.
**How ShowPilot uses it:** Component source of truth. Configuration in `apps/web/components.json` specifies style "new-york", Tailwind CSS, RSC support, and component alias `@/components`. Components in `apps/web/src/components/ui/` include: button, card, dialog, dropdown-menu, input, label, select, separator, tabs, tooltip, badge, table, confirm-dialog. CLI tool `shadcn ^3.8.5` in devDependencies for adding new components.
**Why we chose it:** Components are copied into the project (not imported from npm) — full control over styling and behavior. Matches the dark broadcast aesthetic with minimal customization. Radix-based accessibility. No vendor lock-in.
**Alternatives considered:** Material UI, Chakra UI, Ant Design, DaisyUI
**Why alternatives were rejected:** MUI and Ant Design impose their own design systems — difficult to achieve the broadcast-dark aesthetic. Chakra UI has runtime CSS-in-JS overhead. DaisyUI lacks the interactive primitives (dialogs, dropdowns) that Radix provides. shadcn gives full source ownership with zero runtime overhead.

---

## Framer Motion
**Category:** Animation
**What it is:** A production-ready motion library for React.
**How ShowPilot uses it:** `framer-motion ^12.33.0` provides `AnimatePresence` for mount/unmount animations and `motion` components for layout transitions. Used in interactive components across the app. Split into its own vendor chunk (`vendor-motion`) at 40KB gzip for caching.
**Why we chose it:** Declarative animation API that integrates naturally with React's component model. `AnimatePresence` handles exit animations that CSS alone cannot. Layout animations for reordering (drag-and-drop in rundown).
**Alternatives considered:** CSS animations, react-spring, auto-animate
**Why alternatives were rejected:** CSS animations cannot handle exit animations or layout transitions. react-spring has a steeper API for common cases. auto-animate is simpler but lacks fine-grained control for production UI interactions.

---

## Lucide React
**Category:** Icon Library
**What it is:** A collection of open-source SVG icons as React components.
**How ShowPilot uses it:** `lucide-react ^0.545.0` provides all icons across the application — sidebar navigation, buttons, status indicators, form elements. Icons are tree-shaken (only imported icons are bundled). Used extensively in `apps/web/src/components/layout/Sidebar.tsx` and throughout route components.
**Why we chose it:** Tree-shakeable — only used icons are bundled. Clean, consistent design. React components with proper TypeScript types. Fork of Feather Icons with active maintenance and 1000+ icons.
**Alternatives considered:** Heroicons, React Icons, Phosphor Icons
**Why alternatives were rejected:** Heroicons has fewer icons (300 vs 1000+). React Icons bundles multiple icon sets leading to larger bundles. Phosphor is viable but less widely adopted. Lucide has the best combination of breadth, tree-shaking, and active maintenance.

---

## date-fns
**Category:** Date Utilities
**What it is:** A modular JavaScript date utility library.
**How ShowPilot uses it:** `date-fns ^4.1.0` for date formatting and manipulation across the app — rundown timestamps, chat message times, invitation dates. Tree-shakeable so only used functions are bundled. Split into vendor chunk (`vendor-date`).
**Why we chose it:** Modular and tree-shakeable — unlike Moment.js. Immutable by design. Pure functions that work well with TypeScript. No global state or prototype pollution.
**Alternatives considered:** Moment.js, Day.js, Temporal API
**Why alternatives were rejected:** Moment.js is deprecated and 67KB gzipped. Day.js is smaller but less tree-shakeable. Temporal API is not yet stable across all runtimes (Cloudflare Workers support is limited).

---

## qrcode.react
**Category:** QR Code Generation
**What it is:** A React component for rendering QR codes as SVG or Canvas.
**How ShowPilot uses it:** `qrcode.react ^4.2.0` generates QR codes for overlay URLs and kiosk display links in the settings page and board view. Operators scan QR codes to open kiosk views on mobile devices. Split into vendor chunk (`vendor-qrcode`).
**Why we chose it:** React component that renders to SVG — clean, scalable, no canvas dependencies. Simple API (just pass a value prop). Small footprint.
**Alternatives considered:** qrcode, react-qr-code
**Why alternatives were rejected:** `qrcode` is a raw library without React integration. `react-qr-code` is similar but less maintained. `qrcode.react` has the most downloads and active maintenance.

---

## class-variance-authority (CVA)
**Category:** Component Variant System
**What it is:** A utility for creating type-safe component variant APIs.
**How ShowPilot uses it:** `class-variance-authority ^0.7.1` defines variant props for UI components (button sizes, colors, states). Used in `apps/web/src/components/ui/button.tsx` and other shadcn components. Provides `cva()` function for declaring variants and `type VariantProps` for TypeScript inference.
**Why we chose it:** Part of the shadcn/ui stack. Creates a clean API for component variants without runtime CSS-in-JS. TypeScript inference for variant props eliminates invalid prop combinations.
**Alternatives considered:** Manual className logic, twin.macro, Stitches
**Why alternatives were rejected:** Manual className logic doesn't scale and lacks type safety. twin.macro requires babel/SWC plugins. Stitches is deprecated. CVA is lightweight (2KB) and purpose-built for Tailwind variant patterns.

---

## clsx + tailwind-merge
**Category:** CSS Utility
**What it is:** `clsx` conditionally joins classNames. `tailwind-merge` intelligently merges Tailwind classes, resolving conflicts.
**How ShowPilot uses it:** Combined in a `cn()` utility function (standard shadcn pattern) used across all components for conditional and merged class application. `clsx ^2.1.1` and `tailwind-merge ^3.4.0`.
**Why we chose it:** Standard pattern in the Tailwind ecosystem. `clsx` handles conditional classes. `tailwind-merge` ensures `p-4 p-2` resolves to `p-2` instead of both being applied. Essential for component composition where parent and child may specify conflicting utilities.
**Alternatives considered:** classnames, twMerge alone
**Why alternatives were rejected:** `classnames` is larger and doesn't handle Tailwind conflicts. Using `twMerge` alone requires more verbose conditional logic. The `clsx` + `tailwind-merge` combination is the ecosystem standard.

---

## Vite
**Category:** Build Tool
**What it is:** A fast frontend build tool with native ESM dev server and Rollup-based production builds.
**How ShowPilot uses it:** `vite ^7.1.7` (via `@tanstack/react-start`) handles development server, HMR, production bundling, and code splitting. Configuration in `apps/web/vite.config.ts` with plugins: `@cloudflare/vite-plugin` (SSR on Workers), `@tailwindcss/vite` (Tailwind compilation), `tanstackStart()` (SSR/server functions), `viteReact()` (JSX). Manual chunks split vendor libraries (auth, UI, motion, date, qrcode) for optimal caching.
**Why we chose it:** Required by TanStack Start. Native ESM dev server is significantly faster than webpack. Cloudflare's official Vite plugin enables Workers SSR. Rollup-based production builds with excellent tree-shaking and code splitting.
**Alternatives considered:** webpack, Turbopack, esbuild
**Why alternatives were rejected:** webpack is slower and more complex to configure. Turbopack is Next.js-only. esbuild lacks the plugin ecosystem for SSR and CSS. Vite is the standard for modern React metaframeworks.

---

## wrangler
**Category:** Deployment CLI
**What it is:** Cloudflare's CLI tool for developing and deploying Workers, D1, R2, and Durable Objects.
**How ShowPilot uses it:** `wrangler ^4.69.0` in devDependencies. Configuration in `apps/web/wrangler.jsonc`. Used for: deploying the worker (`pnpm run deploy`), managing D1 migrations (`db:migrate:local`, `db:migrate:remote`), generating worker types (`cf-typegen`), managing secrets (`wrangler secret put`), and tailing production logs (`wrangler tail`).
**Why we chose it:** Required tool for Cloudflare Workers development. No alternative exists for this stack.
**Alternatives considered:** N/A — wrangler is the only CLI for Cloudflare Workers.
**Why alternatives were rejected:** N/A

---

## pnpm
**Category:** Package Manager
**What it is:** A fast, disk-efficient package manager for JavaScript.
**How ShowPilot uses it:** Workspace package manager. Root `package.json` uses `pnpm --filter @showpilot/web` for delegating commands. `pnpm-workspace.yaml` defines the monorepo structure.
**Why we chose it:** Strict dependency resolution prevents phantom dependencies. Disk-efficient via content-addressable storage. Workspace support for monorepo structure. Faster than npm for large dependency trees.
**Alternatives considered:** npm, yarn, bun
**Why alternatives were rejected:** npm has slower installs and allows phantom dependencies. Yarn v4 (Berry) has PnP complexity. Bun's package manager is less mature for production monorepos. pnpm is the most reliable for strict, fast dependency management.

---

## OnTime Integration
**Category:** External Integration (Rundown/Timer)
**What it is:** An open-source broadcast timer and rundown application used in live television and events.
**How ShowPilot uses it:** Read-only sync adapter. `apps/web/src/lib/ontime.ts` polls OnTime's HTTP API — `/api/poll` for timer/clock/current/next event state, `/data/rundown` for event list. Server-side proxy functions bypass CORS. Config stored in D1 AppSetting table (`ontime-url`, `rundown-adapter`). Types defined in `apps/web/src/types/ontime.ts`.
**Why we chose it:** OnTime is the industry reference standard for broadcast rundowns (cited in CLAUDE.md). Many production teams already use it. ShowPilot's native rundown is built to be functionally equivalent to OnTime.
**Alternatives considered:** N/A — OnTime integration is additive, not a replacement. ShowPilot's native rundown serves as the fallback.
**Why alternatives were rejected:** N/A — integration adapters are additive by design.

---

## ProPresenter Integration
**Category:** External Integration (Presentation)
**What it is:** A worship presentation software widely used in churches.
**How ShowPilot uses it:** Dual-mode connection. `apps/web/src/lib/propresenter-client.ts` (415 lines) implements: (1) WebSocket connection to PP7 stage display protocol on port 50001 with password authentication, (2) REST polling fallback via `/v1/presentation/active`, `/v1/status/slide`. Server-side polling in `apps/web/src/lib/rundown.ts` (`pollProPresenterSlide`) bypasses browser CORS. Features: current slide text extraction, scripture detection via regex, next/previous/clear commands. Configurable in settings with safety warnings for cue-push mode.
**Why we chose it:** ProPresenter is the dominant presentation software in church production. Integration allows operators to see and control PP slides from within ShowPilot without switching applications.
**Alternatives considered:** N/A — ProPresenter integration is additive.
**Why alternatives were rejected:** N/A

---

## Vitest
**Category:** Testing Framework
**What it is:** A Vite-native test runner compatible with Jest's API.
**How ShowPilot uses it:** `vitest ^3.0.5` with `@testing-library/react ^16.2.0` and `jsdom ^27.0.0` for component testing. Test command: `pnpm test` runs `vitest run`.
**Why we chose it:** Native Vite integration — shares the same config, transforms, and module resolution. Jest-compatible API for familiarity. Faster than Jest for Vite projects due to shared pipeline.
**Alternatives considered:** Jest, Playwright (component tests)
**Why alternatives were rejected:** Jest requires separate babel/transform configuration for Vite projects. Playwright component tests are heavier for unit testing. Vitest is the standard testing choice for Vite-based projects.

---

## TypeScript
**Category:** Language
**What it is:** A typed superset of JavaScript.
**How ShowPilot uses it:** All source code is TypeScript. Strict mode enabled in `apps/web/tsconfig.json`. Target ES2022. JSX set to `react-jsx`. Path aliases (`@/*` → `./src/*`). Worker types auto-generated in `apps/web/worker-configuration.d.ts`. Custom types in `apps/web/src/types/` for OnTime events, rundown items, and member data.
**Why we chose it:** Type safety across the full stack — from Prisma schema to server functions to React components. Catches integration errors at compile time. Essential for a production tool where runtime errors during live services are unacceptable.
**Alternatives considered:** JavaScript with JSDoc
**Why alternatives were rejected:** JSDoc types are opt-in and less enforced. TypeScript's strict mode catches more bugs. The entire dependency ecosystem (TanStack, Prisma, Better Auth) is TypeScript-first.

---

## Web Crypto API
**Category:** Cryptography
**What it is:** The browser/Worker-native cryptographic API.
**How ShowPilot uses it:** Kiosk token signing in `apps/web/src/lib/kiosk.ts`. HMAC-SHA256 JWT tokens signed with `crypto.subtle.importKey` and `crypto.subtle.sign`. Tokens carry orgId, orgSlug, view type, issued-at, and optional expiration. Used instead of external JWT libraries to stay within Workers' native APIs.
**Why we chose it:** Native to Cloudflare Workers — no npm dependency needed. HMAC-SHA256 is fast and sufficient for internal token signing. Avoids importing `jsonwebtoken` which requires Node.js crypto.
**Alternatives considered:** jsonwebtoken, jose
**Why alternatives were rejected:** `jsonwebtoken` depends on Node.js `crypto` module. `jose` is viable but adds a dependency for a simple HMAC operation. Web Crypto is built-in and zero-cost.

---

## Service Worker (PWA)
**Category:** Progressive Web App
**What it is:** A browser-side script for offline caching and push notifications.
**How ShowPilot uses it:** `apps/web/public/sw.js` (114 lines) handles push notifications with vibration patterns per message type (text, alert, cue), notification click handling (focus or open window), and asset caching (network-first for navigation, cache-first for static). `apps/web/src/lib/notifications.ts` provides registration, permission requests, push subscription with VAPID key, and local notification fallback.
**Why we chose it:** Enables push notifications for production alerts and cues without a native app. PWA install capability for iPad/mobile use in production environments. Offline caching ensures the app loads even on unreliable church WiFi.
**Alternatives considered:** Native mobile app, Electron
**Why alternatives were rejected:** A native app requires App Store distribution and separate codebases. Electron is desktop-only and heavy. PWA covers MacBook, iPad, and Windows — ShowPilot's target devices — with a single codebase.

---

# Summary Table

| Service | Category | Primary reason chosen |
|---------|----------|----------------------|
| React 19 | Frontend Framework | Largest ecosystem, concurrent features, SSR streaming |
| TanStack Start | Metaframework | First-class Cloudflare Workers support, no Node.js required |
| TanStack Router | Routing | Type-safe routes, `beforeLoad` auth guards, `pendingComponent` |
| Cloudflare Workers | Backend Runtime | Zero cold starts, global edge, native D1/R2/DO integration |
| Cloudflare Durable Objects | Real-Time State | Single-instance WebSocket rooms, sub-100ms broadcast, SQLite persistence |
| Cloudflare D1 | Database | Native Workers integration, edge read replicas, zero connection overhead |
| Cloudflare R2 | Object Storage | Zero egress fees, co-located with Workers |
| Cloudflare Stream | Live Video | Native simulcast (Stream Connect), same billing as infrastructure |
| Prisma | ORM | Type-safe queries, D1 adapter, schema-first migrations |
| Better Auth | Authentication | Self-hosted, Workers-compatible, built-in org/RBAC plugin |
| Resend | Email | Simple REST API, works from Workers with just `fetch` |
| Tailwind CSS | Styling | Utility-first, dark theme via CSS variables, v4 Vite plugin |
| Radix UI + shadcn | UI Components | Accessible, unstyled primitives with full source ownership |
| Framer Motion | Animation | `AnimatePresence` for mount/unmount, layout animations |
| Lucide React | Icons | Tree-shakeable, 1000+ icons, active maintenance |
| date-fns | Date Utilities | Modular, tree-shakeable, immutable |
| qrcode.react | QR Codes | SVG rendering, simple React component API |
| Vite | Build Tool | Fast ESM dev server, Cloudflare plugin, excellent code splitting |
| pnpm | Package Manager | Strict dependencies, disk-efficient, workspace support |
| TypeScript | Language | Full-stack type safety, catches errors at compile time |
| Vitest | Testing | Native Vite integration, Jest-compatible API |
| OnTime | Integration | Industry reference standard for broadcast rundowns |
| ProPresenter | Integration | Dominant church presentation software |
| Web Crypto API | Cryptography | Native to Workers, zero dependencies |
| Service Worker | PWA | Push notifications, offline caching, cross-device support |
