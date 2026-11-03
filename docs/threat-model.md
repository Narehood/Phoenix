# Threat model

Project registry metadata is a separate protected data category. Host/group/all
grants do not authorize it; non-admin access requires explicit project grants.
Viewer roles remain read-only. Registration is admin-only, metadata changes need
recent MFA and CSRF/Origin checks, and stale revisions are rejected. Project IDs
cannot be deleted/reused; archived projects still count toward capacity. Audit
storage is bounded to 100 events per project. Maintenance modules other than
read-only GitHub health are unsupported; registry permissions confer no application
data, deployment, restore or shell authority. [Details](project-maintenance.md).

GitHub observations require separate project-scoped read access. Source changes
require an administrator with recent MFA, and tokens remain vault-encrypted on
the server. Collection uses only GETs to the fixed GitHub.com API, refuses
redirects and bounds requests, time, responses and snapshots. Durable cooldowns
survive restarts; source revision and encrypted identity checks prevent late
results from repopulating a disconnected/reconfigured source. Archives and
disabled modules suppress network work and late commits. Failure messages never
forward upstream bodies or credential-bearing transport errors.

Protected assets: host authority, agent keys, browser sessions, command output, Canary viewer credentials and audit history. Threats include a stolen invite, replayed request, revoked certificate on an existing TLS connection, malicious host metadata, unauthorized operator, compromised agent, CSRF, credential forwarding and crash-induced duplicate reboot.

TLS 1.3 is mandatory on every implemented transport. Normal CA/hostname verification is always performed; configured pins add an identity check. A private CA certificate obtained through a trusted channel supports self-hosted installations. There is no verification bypass. Canary origins and resolved destination addresses are explicitly configured, redirects are refused, and tokens never reach browsers. Recoverable secrets use AES-GCM from Go's standard library with a separately retained key.

Passwords use an established password-hashing library and privileged roles require TOTP from a maintained library. Browser sessions use an established session library, Secure/HttpOnly/SameSite cookies, expiry and revocation. Cookie mutations require a session CSRF token and the exact configured Origin. Privileged destructive operations require fresh password+MFA verification and target-specific confirmation. No WebSocket transport is used.

Admin, operator and viewer are role ceilings, supplemented by explicit host/group and action grants. Viewers cannot access command output. Agents apply their own local action policy. Diagnostic actions are fixed executables/arguments; no shell interpolation or arbitrary command strings. Shell capability remains disabled and unimplemented. A root helper is installed separately with a root-owned allowlist; telemetry and the network agent run as an unprivileged account.

Revocation blocks every subsequent request and dispatch and closes tracked connections. Any already executed operation cannot be undone. Root/server compromise and physical access are outside this application's isolation boundary. Audit records are durable, but a database/server administrator can tamper with them; external tamper-evident export is release work. Local helper review, supply-chain review and real Debian tests remain release requirements.
