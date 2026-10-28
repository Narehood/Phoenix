# Phoenix working rules

**Builds resumed by the user (2026-10-27).** Phoenix now shares Canary's existing guarded compiler cache and lock when that sibling checkout is present; never write to the default external compiler cache. Preserve the 16 MiB external-cache ceiling, 256 MiB idle compiler cache, 512 MiB scratch ceiling and one-command rule. Never launch Windows application/test executables: use Linux/container CI for runtime fixtures. Source compilation is not a fixture pass. The earlier cleanup evidence remains in `.validation/cache-cleanup.json`.

- Preserve the product scope in README and docs/milestone.md. Report platform and validation limits precisely.
- Never read existing `.env` files, application databases or private identity state. Test only newly created temporary fixtures. Canary is read-only.
- Run artifact-producing commands through `python scripts/validate.py -- <command>`. One validation command at a time; reuse shared Go/npm caches. No VMs, copied caches or real administrative operations in validation.
- Fixture telemetry, jobs and logs are bounded. Never reboot the developer host or change its services.
- Debian/Linux and systemd are the initial implementation. Windows/SSH interfaces do not imply implemented support.
- Branding and generated graphical assets belong to the user's requested Opus 5.5 agent. Use identified temporary placeholders if unavailable.
