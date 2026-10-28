# Validation and acceptance

Evidence is separated into compilation, fixture execution, actual Debian/systemd operation and production release. A green fixture suite is not a production certification.

## Bounded runner

Run one command at a time through `python scripts/validate.py --timeout <seconds> -- <command>`. In this workstation checkout, it shares Canary's existing compiler cache **and lock**, keeps the default external cache below 16 MiB, trims the owned cache to 256 MiB, caps scratch at 512 MiB and combined repositories at 3 GiB, and preserves module/application data. Elsewhere it uses one owned `.validation/go-build` cache. It retains twelve small results and one 64 KiB log; temporary binaries/databases are removed. Peaks are sampled, not exact instantaneous measurements. No cache copies or persistent VMs are made.

Windows application/test executables are disabled. Local `scripts/check.py compile` cross-compiles Linux amd64 test packages with `go test -c`; **no tests execute**, and the CGO-disabled SQLite stub means this is a source/type check only. `scripts/check.py web` type-checks/builds React. `scripts/check.py vet` statically checks the Linux target. Actual database/test execution requires the CGO-enabled Debian container. The resumed runner does not grow the external cache; the earlier compile checkpoint used the wrong shared-cache location, was paused, and its positively identified artifacts were removed. That checkpoint is not current runtime evidence.

Runtime validation belongs to `docker build --target validate .` and `.github/workflows/ci.yml` on a disposable Linux runner. Docker downloads dependencies during build, then executes fixture tests with `RUN --network=none`; TLS fixtures bind loopback only. The image also runs vet and the Go race detector. All administrative fixture operations use the in-memory `fixturePlatform`; tests never call real service restart/reboot. The Linux telemetry collector and root helper are compiled, not functionally exercised by those fixtures.

## Fixture suite

- Five separately generated private keys/certificates and stable host IDs, with three fresh hosts, one stale host and one offline host. Unknown agent/resource state is distinct from Canary status.
- Single-use invitation reuse and replacement of an active identity refused; wrong CA, superseded certificate, expired certificate and revoked identity refused. Renewal and deliberate revoked-host invitation covered.
- Cookie session setup with MFA, exact-Origin/CSRF rejection, scoped host/action permissions, restricted job output, login throttling and session revocation.
- Durable queued/dispatched/outcome state, interrupted delivery without redispatch, duplicate receipts, server restart uncertainty and dispatch-time authorization checks.
- Agent ledger deduplication across an engine restart, crash after claim, execution deadlines, cancellation, local policy denial, disabled shell, one execution slot and shared stdout/stderr bound.
- Reboot acceptance fixture and later boot-ID observation, with no real reboot.
- Verified Canary GET/Bearer contracts over TLS, two sources with identical monitor names/IDs kept separate, multiple mappings, per-node perspectives/maintenance, unavailable-source freshness, wrong pins/CA, redirects, revision/role mismatch, destination allowlist and response limits.

Add long-duration retention/load, restore drills, complete browser acceptance, helper privilege-boundary tests and dependency advisory scanning before release. These are not implied by the fixtures above.

## Actual Debian/systemd acceptance procedure — not run

Use a disposable Debian 13 VM or physical test host supplied by an operator, separate from development workstations and existing application data. Do not create a large persistent VM as part of this repository's validation. Record exact Debian/kernel/systemd version, image/source SHA, CPU architecture and user identity.

1. Install the server image and a nonroot agent following operations.md. Install the trusted CA before any credentials. Verify setup/MFA, Secure/HttpOnly/SameSite cookie flags, TLS 1.3, wrong hostname/CA/pin rejection and absence of an inbound agent port.
2. Add five independently enrolled test hosts (lightweight fixture processes may supplement the actual Debian machine), keeping one disconnected and another with stale measurements. Verify five host IDs, mapping/source/node identity and separate unknown/offline/resource status.
3. On Debian compare two CPU samples, memory and `/` disk data, network counter/rate changes and uptime/boot ID with local tools; check bounded process/service lists and an approved service's recent journal output. Verify unavailable fields stay unknown and collect timestamps are distinct.
4. Create a **new disposable** `phoenix-acceptance.service` whose sole action writes a marker in its own temporary test directory, with a harmless long-running sleep. Configure only that unit in both allowlists. Restart it from Phoenix and verify the marker and audit/job outcome. Confirm another service, shell text and malformed unit names are rejected. Remove only this test unit after stopping the acceptance run.
5. Keep `allowReboot=false`. Verify reboot confirmation/recent-MFA and local policy rejection using the safe fixture. **Do not issue a real reboot during this acceptance procedure.** A real-machine reboot test requires a separately approved dedicated test machine/window; fixture acceptance does not prove actual reboot behavior.
6. Test a viewer and an operator with one host grant; confirm another host, service restart and output access are denied unless individually granted. Cancel a harmless diagnostic fixture, interrupt its delivery, restart only the fixture server, and confirm no automatic execution repeats.
7. Revoke an agent while connected, verify the connection closes and further dispatch fails, deliberately re-enroll, then exercise renewal and expiry. Test wrong and reused invitations without touching another identity's state.
8. With the operator-provided reachable Canary **node** API, verify the running build and viewer role before activation. Map multiple monitors. Disconnect that source and verify agent management continues while source data becomes stale/unknown. Never send notifications or mutate Canary.
9. Stop the isolated server; backup data and identity separately, restore to an isolated copy with its agent port blocked, revoke restored sessions and reconcile revocations/jobs before reopening. Record pass/fail and retain only a small sanitized report.

Report the actual results in this file with source/image SHA. Until recorded, actual Debian/systemd installation, live telemetry collection, helper execution, live Canary interoperability and backup recovery remain **not run**.
