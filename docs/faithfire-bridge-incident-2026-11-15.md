# Faithfire Bridge investigation — 2026-11-15

GATE PENDING (Rey-side): APC/MTC, LTC, long run, final rehearsal, booth Bridge evidence capture, Demo Bridge handshake (needs Demo-issued key). None was exercised here.

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

## Rey-side booth capture receipt (pending)

Before replacing anything, record the incident machine, macOS version, `uname -m`, and the running Bridge path from Activity Monitor → Open Files and Ports. Quit Bridge only after preserving logs. Set `BOOTH_APP` below to that actual app bundle (including a Downloads copy if that is what ran):

```sh
BOOTH_APP='/Applications/ShowPilot Bridge.app'
/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$BOOTH_APP/Contents/Info.plist"
find "$BOOTH_APP/Contents/MacOS" -type f -exec file {} \;
find "$BOOTH_APP/Contents/MacOS" -type f -exec shasum -a 256 {} \;
```

Retain every filename and hash: both the main executable and engine sidecar are required. Repeat for the actual Desktop bundle if investigating its alert banner. Mount the architecture-matched verified installer read-only with `hdiutil attach -readonly -nobrowse /path/to/installer.dmg`, then repeat the same commands with `BOOTH_APP` pointing at the mounted app. Compare corresponding files, not ARM versus Intel or ZIP versus executable hashes. Preserve logs securely; redact keys, cookies and authorization headers before sharing.

For Cloudflare historical logs, use November 15, 2026 **13:31:00–13:43:59 UTC** (08:31–08:43 EST), worker `showpilot`, host `www.showpilot.tech`, exact path `/api/bridge/faithfire-production/ws`; include redirect destinations if recorded. Export timestamp, method, host/path without secret query values, HTTP response status, exact retained response body/rejection text, Ray/request/correlation ID, Worker deployment/version, outcome/exception, and correlated BridgeRelay events. Record presence and validity outcomes for policy/settings headers and credential/installation checks if already logged, never their secret values. Cloudflare request logs may not retain response bodies: explicitly mark absent fields unavailable; do not infer a body from status alone. Do not reconnect Production to manufacture evidence.

| Captured result | What it establishes |
| --- | --- |
| Installed main or sidecar differs from verified matching artifact | Clears the assumption that the repaired artifact was running; identifies different contents, but does not alone convict the rejection cause. |
| Both match and running path matches | Clears stale installed contents for that artifact; does not prove historical headers or credential state. |
| 426 with policy rejection body | Convicts missing/unsupported policy on that request; inspect the identified binary/header path. |
| 426 with settings recipient rejection body | Convicts missing/invalid SPKI recipient on that request; investigate runtime generation/transport, not stored-key rotation. |
| 401 plus exact authentication reason | Convicts that named credential, installation, internal-auth or query-key check; status alone cannot distinguish them. |
| 403 org mismatch, 404 org missing, 400 role, 405 method, or 503 internal secret | Convicts the named routing/binding/configuration check only when the body/correlated event confirms it. |
| Redirect or edge-generated rejection | Points to host/edge routing before upgrade; does not convict BridgeRelay policy. |
| 101 for a correlated incident request | Clears pre-upgrade rejection for that request only; investigate subsequent close separately. |
| Missing historical body/logs or unidentified booth binary | Verdict remains unreproduced; no speculative fix and no acceptance gate closure. |

## Workstream 3 ledger note — November 16, 2026

Workstream 3: **INVESTIGATED — UNREPRODUCED**. No defect convicted; no speculative fix. Ledger remains **68/79**. The investigation record is ready for Chief’s review independently of the remaining acceptance gates; Chief is the merge gate.

- **GATE PENDING — Rey-side booth Bridge evidence capture:** obtain the running-path/main-and-sidecar hash receipt and retained incident HTTP status/body or correlated Cloudflare rejection evidence described above.
- **GATE PENDING — Rey-side Demo Bridge handshake:** no Demo-issued Bridge credential is available on this Mac. The saved Desktop configuration targets Faithfire Production; its credential was not used, by design. Unblock by issuing a Bridge API key in Demo org `showpilot-demo-nov04` and configuring a Demo Bridge profile on a test machine. Then capture the identified binary’s Demo handshake result with secrets redacted.
- **GATE PENDING — Rey-side:** APC/MTC, LTC, long run, final rehearsal.

These pending gates do not block landing this diagnosis. No Production configuration, credential, data, or runtime was changed; no tests or authentication policy were weakened.
