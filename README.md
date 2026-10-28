# Phoenix

A self-hosted infrastructure dashboard and secure remote management companion to [Uptime Canary](https://github.com/Narehood/Uptime-Canary).

Phoenix owns host inventory, resource telemetry and remote jobs. Canary independently owns uptime checks, incidents and notifications. Neither requires the other to operate. Uptime, agent connectivity and resource freshness are separate facts.

The first milestone targets **Debian/Linux with systemd**: one Go server, SQLite, an outbound Go agent, and a React/TypeScript dashboard. Windows and SSH are future platform/transport implementations, not completed support. This is a development build: compilation, fixture results, actual Debian acceptance and production readiness are reported separately in [validation](docs/validation.md).

**Validated development checkpoint:** [Linux CI on `6fb3ce9`](https://github.com/Narehood/Phoenix/actions/runs/40610125009) passed the five-agent security fixtures, Linux vet/race checks, CGO binaries, React bundle and server image build, including the added approved-restart fixtures. Actual Debian/systemd host acceptance, installed-helper execution, browser acceptance and live Canary interoperability have not run. [Exact evidence and limits](docs/validation.md#recorded-results).

The implemented slice includes administrator setup with mandatory TOTP, revocable browser sessions, single-use agent invitations, verified host-bound mTLS identities, telemetry and bounded history, systemd/process/log inspection, approved diagnostics, allowlisted service restarts, confirmed reboot jobs, durable job/audit records and read-only Canary mappings. Agents open outbound connections only. They run without root and use a separate restricted helper for administrative actions. Reboot development tests use fixtures.

Canary remains independent. Its source contracts were inspected; the user's NetBird-protected deployment and running build are unverified. Live integration requires a trusted, reachable **node API** origin and dedicated viewer account. Nothing changes Canary or contacts notification destinations.

Planned dashboard scope also includes GitHub repository health: repository inventory, PR/review and CI status, vulnerability reports and dependency updates. This integration is **not implemented**; its requirements and acceptance work are tracked in [the milestone](docs/milestone.md#github-repository-health--planned).

- [Architecture](docs/architecture.md) and [threat model](docs/threat-model.md)
- [HTTP and agent protocol](docs/protocol.md)
- [Milestone and remaining release work](docs/milestone.md)
- [Installation, backup and recovery](docs/operations.md)
- [Canary contract evidence](docs/canary.md)
- [Validation and Debian acceptance](docs/validation.md)

For a first installation, follow [operations](docs/operations.md): build the Linux container, configure the exact HTTPS origin, initialize the retained identity, trust the public CA through a trusted channel, then complete password/MFA setup. Enroll agents with private invitation files and verify their certificate fingerprints before approving management access.

Local development checks run one at a time through `python scripts/validate.py -- python scripts/check.py web` or `compile`. The latter only cross-compiles Linux test packages; it never runs Windows test executables. Runtime fixtures, vet and race checks are in the Docker `validate` target and Linux CI. No default credentials, HTTP fallback or arbitrary shell capability are provided. No production readiness, real Debian/systemd acceptance or live Canary compatibility is claimed.
