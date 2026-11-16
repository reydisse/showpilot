# Faithfire Bridge investigation — 2026-11-15

GATE PENDING: real APC/MTC, LTC audio, long run, and final rehearsal. None was exercised here.

## Verdict

Unreproduced; no code defect convicted. Do not change authentication or weaken policy checks. The exact incident HTTP status/body and the booth executable identity remain missing. No Faithfire request, data change, or live verification was performed. Ledger stays 68/79; this investigation closes no acceptance gate.

Investigation base: 41b6e66d. Report prepared November 16. Incident window: November 15 13:31–13:43 UTC (08:31–08:43 EST).

## Hypotheses and evidence

| Hypothesis | Evidence and remaining limit |
| --- | --- |
| Old policy client | BridgeRelay.ts requires policy header exactly `3`, otherwise HTTP 426. Current bridge.ts sends `3`. Local acceptance test “refuses a legacy Bridge upgrade and cannot obtain policy support from URL parameters” passes. Booth headers unknown. |
| Stale settings key after rotation | Current Bridge generates a fresh RSA-OAEP 2048-bit recipient before every connection; server imports the SPKI public key, not an org-stored recipient. There is no persisted recipient rotation dependency on this path. Missing or invalid recipient returns a separate 426. Settings-delivery rejection tests pass. Historical executable remains unknown. |
| Wrong slug | relay-upgrade-cache.server.ts resolves organization ID first, then slug by bound SQL. Missing org returns 404 before relay auth. Correct-looking URL alone cannot prove historical database resolution. |
| Credential/install binding | bridge-credentials.server.ts authenticates header SHA-256 against org-bound credential and non-revoked installation/credential with expiry checks; relay revalidates by ID (401). Fresh key alone does not prove the running process used it or its installation remained valid. No historical credential-state evidence retrieved. |
| Other upgrade rejection | server.ts rejects key-like URL params (401), invalid role (400), missing org (404), unavailable internal secret (503); BridgeRelay also has internal auth (401), org mismatch (403), and method checks (405). “Expected 101” and close 1002 do not distinguish these from policy 426, redirects, or edge rejection. |
| Wrong supplemental binary | Run 43549093258 succeeded at head 23d3301a12c0bd3e4d8ae6cba5bd5a2939bb7b7d. ARM artifact 14095292025 is named unsigned-supplemental-macos-arm-b8f6a705. The distinct run head and name suffix must both be retained; neither version label proves installed identity. No booth hash obtained. |

## Release evidence

Source: https://github.com/reydisse/showpilot/actions/runs/43549093258

GitHub API archive digests (these identify ZIP archives, not their inner DMGs):

- ARM artifact 14095292025: `4ecf02761d775f157cd429ad0485e22a58d346231556087bb51e4e1891605597`.
- Intel artifact 14095741787: `eedc021193158e8cc0ba789f346fb7a99082a0644350d8ef214193bc71137b05`.

Downloaded ARM install-evidence artifact 14095147587 results.json records:

- Bridge DMG `ShowPilot Bridge_0.1.14_aarch64_SUPPLEMENTAL-ENTITLEMENTS-UNSIGNED.dmg`: SHA-256 `2ecaa611f1ed12b8cf8e2507533d7b85ebbae3d50a52651b30a7be0290d8b5e9`.
- Desktop DMG `ShowPilot Desktop_0.1.8_aarch64.dmg`: SHA-256 `27338f13d36d4788520390626808eb9258fb90714fd25e9a8a51902be1898dea`.
- Both survived 10 seconds and passed authenticated loopback status plus 10,000 roundtrips. This is packaging evidence, not a successful cloud handshake or booth installation evidence.

## Exact remaining diagnostic and installation procedure

1. Preserve booth logs and identify the actual running process using Activity Monitor → select Bridge/Desktop → Open Files and Ports. Record executable path, architecture (`file`), and SHA-256 (`shasum -a 256`) for the main executable AND each packaged sidecar under Contents/MacOS. Do not record API keys. A duplicate app in Downloads can differ from /Applications.
2. Download the matching architecture artifact from the run above. Hash the archive against its API digest and ARM DMGs against the evidence above. For Intel, download supplemental-install-evidence-macos-intel and use its installer hashes; do not use ARM hashes.
3. Mount the verified DMG read-only. Hash the corresponding main and sidecar files inside its app bundle and compare each to the installed app. This comparison identifies installed contents even though version 0.1.14 is ambiguous. Record run URL, artifact ID, installer hash, main/sidecar hashes and running path together as the install receipt. Perform this receipt check for every replacement installation; an installer hash alone does not prove which app was launched.
4. In Cloudflare Workers Logs for worker showpilot, query the UTC incident window and request path /api/bridge/faithfire-production/ws. Export response status, request/correlation ID, deployment/version and any rejection reason already retained. Inspect BridgeRelay events for that request. Historical logs have NOT been retrieved in this investigation; Wrangler authentication was confirmed, but `tail` would only observe future traffic and cannot recover this incident. If logs retain only status 426, the two return bodies/checks still must be distinguished; do not assert which failed.
5. If historical logs are unavailable, preserve that limitation. Do not reconnect to Faithfire to obtain evidence. Reproduce only with Demo slug showpilot-demo-nov04 using the exact identified booth binary and Demo-issued credentials. Capture non-101 HTTP status/body without logging credential headers. Compare with the verified repaired binary under the same Demo configuration.
6. Remediate only after classification: verified older binary → install verified matching build and confirm its running path; 401 → check Demo credential/install binding and process configuration; policy 426 → confirm header 3 from actual binary; settings-key 426 → validate SPKI generation/runtime; 404 → check resolved slug; redirect/edge rejection → inspect host routing. Do not rotate production keys or alter production settings as an experiment.

The old Desktop alert banner supports investigating stale Desktop contents but does not identify the Bridge binary or prove a shared cause. Final November 15 connection outcome remains unknown.

## Validation

- Bridge Vitest suite: 22 files, 158 tests passed (the package command ran the full suite).
- Worker bridge-settings-delivery and bridge-target-enforcement: 2 files, 22 tests passed.
- No live Demo handshake run; no live credentials used. No production logs retrieved, no production DB queried or modified. No application code changed.
