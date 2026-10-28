# Milestone and product scope

The full goal includes fleet inventory, telemetry, processes, services, bounded logs/history, durable approved commands, service management, explicit reboot, secure lifecycle enrollment, permissions, independent Canary status and GitHub repository health. Windows, additional transports, start/stop actions, broader diagnostics and GitHub integration follow the first Debian slice; they remain product scope.

Implemented slice validated through the Linux fixtures on checkpoint `6fb3ce9`; the session-revocation, administrator-only mapping and helper-timeout regressions subsequently passed the fixture/race stages on `de67ade`. That run's browser stage failed during Chrome startup. Later changes require the current PR check; checkmarks below are not claims of actual-host or complete browser acceptance ([evidence](validation.md#recorded-results)):

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

## GitHub repository health — planned

Requested on 2026-10-28. The dashboard should show the user's selected GitHub repositories and what needs attention across them. No GitHub collector, credentials flow, persistence, API or dashboard view is implemented yet.

- [ ] Repository inventory with owner/name, visibility, archived state, default branch, recent activity and links to GitHub
- [ ] Open PRs with draft/review state, failing or pending checks, merge conflicts and age; distinguish PR checks from default-branch CI
- [ ] Vulnerability reports with severity, affected dependency or finding, available fix and source link; include Dependabot and other GitHub security findings where enabled and authorized
- [ ] Dependency maintenance with separate security-fix and routine version-update PRs, including Dependabot/Renovate updates; define manifest/package-version coverage before claiming a complete list of outdated dependencies
- [ ] Attention filters and per-repository detail with last successful sync and explicit stale, disabled, unsupported, permission-denied and rate-limited states; missing data must never appear as zero alerts or an up-to-date dependency set
- [ ] Server-side credentials with minimum read permissions, explicit private-repository access, bounded polling/storage, backoff and Phoenix authorization for repository/security data
- [ ] Fresh temporary fixtures for pagination, partial permissions, expired credentials, rate limits and stale/disabled sources, followed by browser acceptance and an explicitly configured live read-only integration check

The first integration is read-only. GitHub availability must not block host management or Canary reads. Repository health, host health and Canary uptime retain separate status and freshness. An empty dependency-update PR queue is not evidence that all packages are current: [Dependabot alerts](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts) concern known vulnerable dependencies, while [version updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-version-updates) depend on configured ecosystems and update policy.
