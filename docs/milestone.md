# Milestone and product scope

The full goal includes fleet inventory, telemetry, processes, services, bounded logs/history, durable approved commands, service management, explicit reboot, secure lifecycle enrollment, permissions and independent Canary status. Windows, additional transports, start/stop actions and broader diagnostics follow the first Debian slice; they remain product scope.

First slice checklist (checked only after implementation and validation):

- [ ] Secure setup/login, privileged MFA, sessions, throttling, CSRF and authorization
- [ ] Authenticated enrollment, host-bound mTLS, rotation, expiry, revocation and re-enrollment
- [ ] Inventory/fleet/detail and actual Linux telemetry collector
- [ ] Read-only systemd/process/log inspection
- [ ] Approved diagnostic, allowlisted restart, confirmed recent-auth reboot fixture
- [ ] Durable job/audit lifecycle, deduplication, deadlines, cancellation and uncertainty
- [ ] Canary mapping and viewer reads against verified source fixtures
- [ ] Five independent fixture identities, offline/stale state and security failure controls
- [ ] Installation, configuration, backup/recovery and actual Debian acceptance procedure

Release gates: deployed Canary revision/contract validation; actual Debian/systemd installation and helper execution; browser acceptance; independent security review; dependency advisory scan; Linux race tests; signed artifacts and upgrades; restore drill and bounded long-duration retention verification. A fixture pass does not satisfy these gates.
