# WS4 silent confirmation investigation — incomplete

Base: main 4346550. Branch: fix/ws4-silent-confirmation.

No reproduction, root-cause fix, acceptance coverage, or live verification is claimed.
Ledger 19ab826391d68d1f remains Partial and unchanged.

Additional source observations:
- Native Show (`apps/mobile/src/app/show/[showId].tsx:215`) gates controls on `relay.unconfirmedCount === 0`; a pending request therefore has an operator-visible consequence without a badge.
- Native relay timeout recovery emits routine retry narration at `apps/mobile/src/hooks/use-rundown-relay.ts:138`.
- Web relay timeout recovery emits routine retry narration in `apps/web/src/hooks/useRundownSync.ts`.
- Native connection retirement requeues pending requests without incrementing their attempt counter. Establish with a deterministic reconnect/ack-loss test whether repeated retirement defeats the timeout retry bound before changing recovery semantics.

Remaining work: reproduce across Live Show and mobile surfaces; trace server acknowledgement and receipt replay for each relevant command; implement silent bounded safe recovery; add named ack-success, genuine-failure and lost-ack acceptance coverage; verify the ledger mutation checklist; create one PR, run final-head CI and mark READY only after verification. Live checks must use showpilot-demo-nov04 only.

GATE PENDING: APC/MTC, LTC, long run, final rehearsal, booth Bridge evidence, Demo Bridge handshake. These do not block this slice.

## Deterministic characterization (2026-11-16)

Added `characterizes lost acknowledgements across repeated mid-flight reconnects`
to the web hook suite. With fake timers, twenty reconnects at four-second
intervals preserve the original request ID, payload and revision, and keep
`unconfirmedCount=1` and `saving=true` for eighty seconds. A matching accepted
acknowledgement then clears both. This is a finite witness of the unbounded
recovery mechanism, not a live reproduction or direct inspection of internal
attempt counters. Native control gating remains a source observation only.

Validation: focused useRundownSync suite passes, 20/20 tests. No production
behaviour changed. Ledger remains Partial; no mutation checklist item closed.
Remaining: native lifecycle tests, explicit attempt-counter coverage, bounded
silent recovery on both hooks, once-only retirement messaging with honest
uncertainty about execution, mutation checklist verification, final-head CI,
and one ready PR against main. No live checks performed.
