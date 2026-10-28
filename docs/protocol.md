# HTTP and agent contract v1

JSON uses camelCase and UTC Unix milliseconds. Errors contain only a public `error` message. Request bodies are limited; unknown fields are rejected. No credentials in query parameters. Browser API and enrollment require TLS 1.3. Agent exchange uses a separate mTLS listener.

Browser authentication: setup begin/finish, login, logout, session, recent-authentication and session revocation endpoints. Successful login returns a CSRF token; mutations require it in `X-CSRF-Token` and the exact configured Origin. Passwords/TOTP are request-body values. Setup requires the private bootstrap token file and proof of MFA before activation.

Inventory and management: list/detail/update hosts, issue invitations, revoke agents, configure user grants, list/create/cancel jobs, inspect audit records and map Canary monitors. GET never dispatches an action. Job action enums distinguish `diagnostic`, `service.restart`, `services.inspect`, `logs.read` and `host.reboot`; validated arguments never form a shell command. Reboot confirmation names the host ID. Job output needs a separate action grant.

Enrollment accepts invitation and a signed CSR, returns a host-bound certificate and public CA. The TLS server's identity must already be trusted before sending the invitation. Renewal is authenticated by the current active certificate and a new locally generated CSR/key, atomically rotates the active serial, then the agent reconnects. Re-enrollment is explicit after revocation.

Agent exchange carries protocol version, agent version, bounded telemetry, completed job receipts and current boot ID. The server returns at most one job, its absolute expiry/deadline and cancellation state. Receipts include durable job ID, stdout/stderr, exit code, timestamps and an outcome (`succeeded`, `failed`, `timed_out`, `cancelled`, `uncertain`, `accepted`). Agent claims are persisted before execution. Duplicate dispatch returns the stored receipt or uncertain state without rerunning. The server never redispatches an uncertain destructive action.

Implemented routes (v1):

| Method/path | Authorization and body |
| --- | --- |
| GET `/api/auth/status` | Public; `setupRequired`, `mfaRequired` |
| POST `/api/auth/setup/begin` | Exact Origin, throttle, private setup token; `{token,name,password}`; returns one-time MFA secret |
| POST `/api/auth/setup/finish` | `{token,code}`; verified MFA activates administrator and creates session |
| POST `/api/auth/login` | Exact Origin and throttle; `{name,password,code}`; returns public user and `csrfToken` |
| GET `/api/session` | Authenticated public user and CSRF token |
| POST `/api/auth/logout` | Authenticated + CSRF; destroys current session |
| POST `/api/auth/recent` | Authenticated + CSRF; `{password,code}`; five-minute window; no code replay |
| POST `/api/auth/revoke-sessions` | Admin + recent + CSRF; revokes all browser sessions |
| GET `/api/hosts` | Filters by `host.read`; separate connectivity, freshness and resource health |
| GET `/api/hosts/{host}` | `host.read`; host and newest 240 samples |
| PATCH `/api/hosts/{host}` | Admin and `host.manage`; `{name,tags,groups}`; group changes affect scopes |
| POST `/api/invitations` | Admin + recent; `{name,groups,reenrollHost?,confirm?}`; one-time invitation and target ID |
| POST `/api/hosts/{host}/approve` | Admin + recent; `{confirm:<host ID>,certificateFingerprint}`; trusted-channel comparison required |
| POST `/api/hosts/{host}/revoke` | Admin + recent; `{confirm:<host ID>}` |
| GET/POST `/api/users` | Admin; create requires recent and `{name,role,password}`; returns one-time MFA secret, no grants |
| PUT `/api/users/{user}/grants` | Admin + recent; `{grants:[{scopeType:"host"|"group"|"all",scope,action}]}`; replace all grants; cannot change own/admin grants |
| POST `/api/users/{user}/disable` | Admin + recent; non-admin account only; revokes all sessions |
| POST `/api/hosts/{host}/jobs` | `host.read` plus action, verified non-revoked identity; `{action,args,timeoutSeconds?,expiresSeconds?,confirm?}` |
| GET `/api/jobs` | `host.read` per target; newest 200; no output |
| GET `/api/jobs/{job}` | `host.read`; result included only with `jobs.output` |
| POST `/api/jobs/{job}/cancel` | `jobs.cancel`; queued job cancels immediately, running job gets cancellation request |
| GET `/api/audit` | Admin or `host.read` per target; newest 500; no credentials/outputs |
| GET `/api/canary` | Admin inventory or mapped `host.read` views; no tokens or private monitor settings |
| PUT `/api/hosts/{host}/mappings` | `host.manage`; `{mappings:[{sourceId,monitorId}]}`, at most 20 |
| GET `/api/canary/{source}/monitors/{monitor}/history` | Mapped host read permission; bounded/throttled server-side viewer read |
| POST `/enroll` | Authenticated server TLS, invitation, signed CSR and Linux metadata; no browser session required |
| POST `/agent/exchange` | Agent listener, TLS 1.3 mTLS and current serial; one optional receipt, one optional reading, optional runningJob |
| POST `/agent/renew` | Current non-revoked agent mTLS; `{csr}`; old serial retires immediately |

Every cookie-authenticated mutation also requires exact Origin and `X-CSRF-Token`. Bodies are 256 KiB except exchange (1 MiB to allow JSON-escaped 64 KiB outputs plus telemetry). Request/response strings are plain untrusted content. Agents send one durable receipt at a time; acknowledgements retire transmission, while a bounded local tombstone remains.

Actions and arguments:

| Action | Args | Additional checks |
| --- | --- | --- |
| `diagnostic` | `{diagnostic:"system.summary"}` | Executes fixed `/usr/bin/uname -a`; local policy |
| `services.inspect` | `{}` | Fixed bounded systemctl listing |
| `logs.read` | `{service:"name.service"}` | Valid unit, local log allowlist, 200 lines/64 KiB |
| `service.restart` | `{service:"name.service"}` | Valid unit, host confirmation, recent MFA, two local allowlists, privileged helper |
| `host.reboot` | `{}` | Host confirmation, recent MFA, explicitly enabled local/helper policies |

`confirm` is the exact host ID for destructive actions. It is not a reusable authorization token. Service names must match `[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.service`. Unknown actions, shell strings, extra fields, invalid timeouts and invalid platform metadata are rejected. Queue expiry is 1–300 seconds; execution deadline is 1–30 seconds from dispatch, capped by expiry. No start/stop or shell action is implemented yet.

Job states are `queued`, `dispatched`, `succeeded`, `failed`, `timed_out`, `cancelled`, `expired`, `denied`, `uncertain` and reboot-only `accepted`. Dispatch is durable before delivery, so losing the response can leave an action uncertain without execution. Late receipts can reconcile uncertain state. `rebootObserved` is independent of acceptance. Dispatch captures the current boot ID, not the boot ID when an offline host's job was queued.
