# Debian test handoff

This guide is for testing the implemented Debian/Linux slice, including Projects
and read-only GitHub health. It is a development build, not a production release.
Windows/SSH, documentation/content editors, dependency updates and deployment
workflows remain planned. Keep the pull request in **draft** until the operator
manually approves it for review; passing checks do not grant that approval.

## Get the exact tested build

Open the draft PR's **Phoenix Linux validation** check. Use a successful run for
the current head, and download `phoenix-linux-amd64-test-kit` from that run's
artifacts. Artifacts expire after seven days; rerun validation if needed. The kit
is uploaded only after fixtures, race checks, built-binary smoke and browser
regressions pass. No image is published or deployed by CI.

Extract the downloaded artifact ZIP in a new directory on a disposable Linux
test machine, then verify and unpack its inner archive:

```sh
sha256sum -c SHA256SUMS
tar -xzf phoenix-linux-amd64-test-kit.tar.gz
cd phoenix-test-kit
sha256sum -c SHA256SUMS
cat build-info.json
```

`sourceSha` identifies the exact Actions checkout. For a PR, GitHub normally
tests a temporary merge commit: it may differ from the branch head. Keep the run
URL and both SHAs in your test report. Checksums detect transfer changes; these
are unsigned development artifacts, not signed releases.

The kit contains CGO-enabled Linux amd64 server/agent/helper binaries, the built
dashboard, example configuration, agent unit/sudoers file and documentation.
No accounts, private keys, project tokens, database or retained state is bundled.
Use Debian 13 on amd64; these binaries are not for Windows, ARM or musl systems.

For the server, follow [operations](operations.md) using the container built from
the same source checkout, or install the kit's `bin/phoenix` and `web/` on the
test server and set `webDir` to the installed dashboard directory. In the latter
case create separate private writable data/identity directories, run the server
as a dedicated nonroot user, configure both TLS listeners, and run `init` then
`serve` with the new configuration. Files under `deploy/` are examples, not a
running configuration. Do not overwrite an existing installation or identity.

Install the two agent binaries using the exact root-owned paths/modes and the
restricted helper policy in [operations](operations.md#enroll-a-debian-agent).
Extracting a kit does not install or enable a service. Trust the public CA through
a trusted channel before supplying any setup token or enrollment invitation.
Keep reboot disabled in both policies throughout acceptance.

## What CI establishes

The normal Debian CGO fixtures test the real APIs/SQLite with safe executors and
temporary integration sources. Linux vet/race checks cover the agent, server,
security, GitHub, Canary and helper policy boundary. Helper fixtures reject
untrusted files, symlinks, FIFOs, oversized policies, disallowed actions and stale
deadlines; they never execute sudo or systemctl.

The additional binary smoke stage runs as UID 10001 with external networking
disabled. It initializes a new server, verifies TLS and MFA/session setup,
registers a temporary project, enrolls and approves a real agent CLI, observes two
actual container procfs samples, and dispatches only `uname -a`. It stops both
binaries, copies that temporary database and identity separately, restores them
in isolation, runs offline administrator recovery and verifies old-session
rejection plus retained hosts/projects/jobs. Logs and state are bounded and
removed. This is container evidence, not an installed-host restore drill.

The browser regressions use the built dashboard with temporary API fixtures.
They cover independently held initial reads, local aging of positive evidence,
project/grant/host controls during delayed saves, guarded service submissions,
effective host-action permissions, compact mobile summaries, and populated CPU
history with gaps and missing values. Chrome accessibility-tree checks retain
responsive table roles and column headers; these are not a screen-reader
acceptance test.
The smoke uses real APIs but does not drive a browser. Neither substitutes for
manual end-to-end browser acceptance. Container systemd service/log inspection
may be unavailable; the smoke never installs or executes the root helper.

## Manual test sequence

Record pass, fail or not run for each row. A missing credential or test host is
**not run**, never a pass. Stop on an identity, authorization or unexpected
administrative-action failure.

| Area | Test and expected result |
| --- | --- |
| Installation | Complete the [actual Debian/systemd procedure](validation.md#actual-debiansystemd-acceptance-procedure--not-run) on a dedicated test host; record OS/kernel/systemd/architecture and exact build/run. |
| Authentication | Complete setup/TOTP, sign out/in, refresh identity, expire/revoke a session; rejected access must not leave another user's data on screen. |
| Hosts | Enroll and compare fingerprint through a trusted channel before approval; compare two telemetry samples and process/service/log readings with the test host; disconnect one agent and distinguish offline from stale resources and Canary status. |
| Jobs | Run the fixed diagnostic; use only the new disposable acceptance service for a confirmed allowlisted restart; verify forbidden services/shell and unauthorized output are refused; verify audit and uncertainty handling. Do not test real reboot. |
| Accounts | Create an operator and viewer with narrow host/project grants; verify role ceilings, inaccessible resources, failed grant loading and preservation of mixed grants. Confirm host request controls reflect effective action grants, update after grant removal, and stay disabled when permissions cannot be loaded; submitted requests must still be authorized by the server. |
| Projects | Start empty; register a temporary project, edit metadata, provoke a two-tab revision conflict, archive and restore; verify bounded audit and explicit unsupported modules. |
| GitHub | Optionally connect an operator-supplied disposable repository with a dedicated read-only token; verify PR checks/reviews, recent push CI and Dependabot observations, cooldowns and stale/permission states; disable/disconnect and ensure old observations do not reappear. Empty results never prove packages current. |
| Canary | Only with a reachable operator-supplied node API/viewer account, verify source/build, independent freshness, mappings and unavailable-source behavior. Do not modify Canary or contact notification destinations. |
| Recovery | Complete a stopped, isolated backup/restore drill with separate identity keys, revoke restored sessions, reconcile agents/jobs, and verify permissions before reconnecting. |
| Browser | Use the real server in desktop, narrow and short viewports. Check Back/Forward, refresh and copied host/project links; decline leaving an unsaved edit or one-time account setup. Reach sign-out in short desktop/mobile windows, dismiss the menu with Escape and verify heading focus. Filter agent/reading issues, inspect warning measurements without expanding a card, and confirm stale values/services say last known. Fail one dashboard endpoint and verify successful sources keep updating. Reveal exact times by tap or keyboard. Check local project errors, verification expiry and success announcements with a screen reader. Inspect errors/empty/loading states and branding at small sizes. Record browser/version. |

Use this report shape, with sanitized evidence only:

```text
CI run URL / tested checkout SHA / PR head SHA:
Kit SHA-256:
Debian / kernel / systemd / architecture:
Browser and version:
Area | pass/fail/not run | observation and sanitized evidence
Open defects and reproduction steps:
Tester and date:
```

Actual Debian/helper operation, live integrations and complete manual browser
acceptance remain unrun until recorded. Independent security/advisory review,
signed upgrades and long-duration/load gates still precede production release.
