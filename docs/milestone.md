# Milestone and product scope

The full goal includes fleet inventory, telemetry, processes, services, bounded logs/history, durable approved commands, service management, explicit reboot, secure lifecycle enrollment, permissions and independent Canary status. Windows, additional transports, start/stop actions and broader diagnostics follow the first Debian slice; they remain product scope.

Implemented slice validated through the Linux fixtures on source `c438a65` ([evidence](validation.md#recorded-results)):

- [x] Setup/login with verified MFA, revocable sessions, throttling, CSRF and scoped authorization
- [x] Authenticated enrollment, fingerprint approval, host-bound mTLS, rotation, expiry, revocation and deliberate revoked-host invitations
- [x] Inventory/fleet/detail API and UI with bounded telemetry models, freshness and independent connectivity state
- [x] Typed diagnostic/restart/log policies and a confirmed recent-auth reboot workflow exercised with safe executors
- [x] Durable job/audit lifecycle, deduplication, deadlines, cancellation and uncertainty
- [x] Canary mapping and authenticated viewer reads against verified source fixtures
- [x] Five independent fixture identities, offline/stale state and security failure controls
- [x] Linux-targeted vet, fixture race checks and server/agent/helper plus React/container builds
- [x] Installation, configuration, backup/recovery documentation and a real Debian acceptance procedure

Still pending before claiming actual host acceptance:

- [ ] Install and run the nonroot agent on a real Debian/systemd test host; verify actual telemetry/process/service/log readings
- [ ] Execute an approved diagnostic and disposable-service restart through the installed helper on that host
- [ ] Exercise re-enrollment through an actual installed agent and complete a backup/restore drill
- [ ] Browser and visual acceptance, including the generated branding at small sizes
- [ ] Verify the deployed Canary node/build and its dedicated viewer reads behind the user's private network

Release gates: the pending acceptance above; independent security review; dependency advisory scan; signed artifacts and upgrades; bounded long-duration/load verification; and inventory metadata refresh after enrollment. Linux fixture/race tests have passed, while production readiness remains unclaimed. A real reboot has not been attempted; development validation stays with the safe reboot fixture.
