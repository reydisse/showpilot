# Browser live-sync investigation — 2026-11-17

## Verdict

Unreproduced; no code defect convicted. Under the Workstream 6 protocol, two browser clients and one native-style client in the same org/show all received every live rundown push, from two different source clients. No production code changed, and no speculative fix is warranted. The Nov 8-9 report (browser clients in an org stopped receiving live pushes after the Nov 6 Phase 1 merges, while native clients stayed live) remains unexplained historically; the exact historical org, clients, and network conditions cannot be recreated.

Investigation base: b1e15d71710febd578a3d1408f3aac77d3dc9ab9 (main). Report prepared November 17, 2026. Original report window: November 8-9, 2026, parked unreproduced since.

## Protocol and live evidence

Method (the one-prompt's Workstream 6 protocol): reproduce in the Demo org with two browser clients and one native client, following the relay subscription path end to end. Executed with the run's established rehearsal vehicle: a local build of the investigation base with the unchanged local smoke fixture and a disposable local database (fixture org `display-smoke`, show `smoke-show`, service date `2026-11-17`). No production access and no production data changes. The native client was a Node `ws` socket connecting the way the mobile app does (explicit stored `Cookie` header per `apps/mobile/src/lib/auth-transport.ts`, ambient cookie jar cleared); the browsers used real browser WebSockets with ambient cookies.

Two live rundown mutations were performed, one from each browser client. Both source requests returned HTTP 200. All timestamps UTC, November 17, 2026.

| Client | Source: browser 1, revision 4 | Source: browser 2, revision 5 |
| --- | --- | --- |
| Browser 1 | Received `09:00:14.302Z` | Received `09:00:14.339Z` |
| Browser 2 | Received `09:00:14.302Z` | Received `09:00:14.339Z` |
| Native-style socket | Received `09:00:14.302Z` | Received `09:00:14.339Z` |

Received frames (excerpt, identical shape on all three clients):

```text
{"type":"state","showId":"smoke-show","serviceDate":"2026-11-17",
 "state":{"revision":4,"stageMessage":"WS6 confirmed source 1",...}}

{"type":"state","showId":"smoke-show","serviceDate":"2026-11-17",
 "state":{"revision":5,"stageMessage":"WS6 confirmed source 2",...}}
```

Browser 2's first connection attempt returned 401 because it had not yet presented its fixture cookie; it was authenticated and hydrated before either recorded trial. That was a fixture setup miss, not a relay behaviour.

Coverage limit, stated plainly: the live limb exercised the rundown relay push path. The timecode and chat paths were covered by the code trace below and the existing suites, not by a separate three-client live trial.

## Subscription-path trace (browser vs native)

- Client construction/auth: browser `useRundownSync` (`apps/web/src/hooks/useRundownSync.ts`) and `useTimecode` (`apps/web/src/hooks/useTimecode.ts`) construct sockets with ambient cookies. Mobile's `use-rundown-relay.ts` / `use-timecode-relay.ts` call `createAuthenticatedWebSocket` (`apps/mobile/src/lib/auth-transport.ts`), which retrieves stored credentials, clears the native ambient cookie jar, and supplies an explicit `Cookie` header plus an optional `x-showpilot-rundown-pin`.
- Upgrade/auth: `apps/web/src/server.ts` (`fetch`, `getRelayAccess`, `canUse`) handles both client classes through the same rundown/timecode routes and permission checks. Credential presentation differs; there is no browser-specific relay branch. `RelayUpgradeCache` (`apps/web/src/lib/relay-upgrade-cache.server.ts`) keys session caching from the authorization and cookie headers, 15-second maximum lifetime bounded by session expiry.
- Room binding: `server.ts::fetch` uses `rundownRelayKey` for rundown and `resolveTimecodeTarget` / `getShowTimecodeRelay` for timecode. Both classes bind through the same resolved org/show identity.
- Registration/attachments: `RundownRelay.ts` and `TimecodeRelay.ts` `/ws` handlers call `acceptWebSocket` and serialize server-derived authority/scope attachments. No platform distinction is registered.
- Fan-out: `RundownRelay::broadcastState` and `TimecodeRelay::broadcastState` / `broadcast` send to the registered sockets using their authority attachments, without browser/native classification.
- Chat: mobile chat shares `createAuthenticatedWebSocket`; chat uses its own route, room binding, and `ChatRelay.ts` (`fetch` / `broadcast`). It shares the authentication pattern, not the rundown/timecode Durable Objects.

The only divergence anywhere on the path is how credentials are presented (ambient cookie vs explicit header). Nothing server-side treats a browser socket differently from a native socket after upgrade.

## Nov 6 candidate changes (audited, none convicted)

| Commit | Finding |
| --- | --- |
| `b073e01a` | Changes timecode source ticking and outgoing feeding in `useTimecode`, including worker-backed ticking. No upgrade, registration, or broadcast change capable of selectively suppressing browser subscriptions. |
| `1e685032` | Changes browser `useTimecode` hydration timeout, reconnect handling, malformed-message handling, and retained state. It can close/reconnect browser sockets on failed hydration or parsing; no server fan-out change or demonstrated defect. |
| `7b12e048` | Changes browser `useRundownSync` validation, hydration timeout, scope checks, and connection recovery. A browser-specific receive-path candidate, because invalid/mismatched frames trigger disconnects; the live trials showed successful browser delivery. |
| `babbff5c` | Changes pending-command handoff on navigation/pagehide and recovery notices. No subscription registration or broadcast change supporting selective browser push loss. |

If the symptom ever recurs, the first suspects are the browser receive-path behaviours in `1e685032` and `7b12e048` (hydration timeout and frame validation disconnecting and reconnecting the socket). Capture, before refreshing: which surface (rundown/timecode/chat), the affected org and show, timestamps, whether other browser clients in the same org were affected simultaneously, and whether a reconnect or refresh restored pushes.

## Existing suites

| Suite | Result |
| --- | --- |
| `useTimecode.test.tsx` + `rundown-sync.test.ts` | 42 passed, 0 failed |
| `rundown-relay.worker.test.ts`, `chat-relay.worker.test.ts`, `relay-read-cache.worker.test.ts`, `relay-upgrade-cache.worker.test.ts`, `relay-sequence.worker.test.ts` | 76 passed, 0 failed |

## Validation

- Local build of b1e15d7 passed; rehearsal ran entirely against the disposable local fixture database.
- No production access, no production logs retrieved, no production DB queried or modified, no live credentials used.
- No application code changed. This investigation closes no acceptance gate and changes no ledger count.
