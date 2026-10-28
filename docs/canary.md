# Canary evidence and deployment gate

The sixteen-source limit counts retained source IDs, including older deployment revisions. Credential refresh for an existing ID remains allowed at capacity; a new ID is refused rather than silently omitted from polling. Automatic source retirement is not implemented.

Inspected read-only on 2026-10-27: local Canary checkout `3bb63a5f6a3c721ce4ccb0c0667de1d1dc65b974`, `docs/api.md`, `docs/transport-tls.md`, `packages/shared/src/index.ts`, and `apps/node-go/internal/canary/{api,types,views,history_api}.go`.

Verified source contracts: `GET /api/overview`, `GET /api/monitors`, `GET /api/monitors/:id/history?limit=100` with `Authorization: Bearer <account token>`. Overview has `node`, optional `build`, `now`, `monitors`, `nodes`, `maintenance` and `user.role`. MonitorView contains `monitor`, `state`, `observations`, `unknownNodes`, `configConflict` and optional `maintenanceIds`. Observations retain `monitorId`, `nodeId`, `state`, `checkedAt`, latency and message. History is local to the queried node and bounded to 1–1000 records. `/healthz` proves only application liveness. No authenticated event webhook contract was assumed.

The user's deployment is behind NetBird. A read-only web fetch could not access it. The running revision and whether that origin serves the dashboard or a node API are **unverified**. The dashboard server has distinct contracts; do not assume its `/api/overview` is a node API. Live activation requires an explicit reachable **node API** origin, a dedicated viewer token, trusted CA, allowed destination addresses and verified running build identity. Until then only a source-contract fixture adapter may run. No changes to Canary, accounts, notifications or data are authorized by this work.

The adapter is server-side, GET-only, refuses redirects, checks viewer role, uses a deadline, bounded response and polling/backoff. It preserves source+monitor+observing-node identity, maintenance and measurement/collection timestamps. It must never expose the token or private monitor configuration to the frontend.

Configure a separate JSON file mounted read-only on the server and reference it with `canaryFile` in `server.json`:

```json
[{"id":"canary-office","origin":"https://canary-node.example.net:3100","expectedNodeId":"verified-node-id","expectedRevision":"<verified full 40-character running source commit>","allowedIps":["192.0.2.10"],"caFile":"/etc/phoenix/canary-ca.pem","pin":"","tokenFile":"/run/secrets/canary-viewer"}]
```

These are placeholders, not a runnable deployment. Obtain the viewer token and CA through trusted administration, without Phoenix changing Canary. The token file is read only at server startup, encrypted in SQLite with the separate key, and never returned by an API. A source ID's origin/node/revision config is immutable: use a new source ID after re-verifying a changed deployment. Reload a rotated token through the file and server restart. All resolved addresses must be in the explicit list, credentials never go through a proxy or redirect, and certificate pins supplement CA/hostname trust. Revision comes from the verified overview's `build.sourceCommit` (or `build.imageRevision` when source commit is absent). A role other than viewer or an unexpected revision fails closed. Polls start every 30 seconds, back off to ten minutes on failure, have an eight-second timeout and 2 MiB response cap. Up to sixteen sources and 500 monitors/source are accepted, but only the five-host fixture scale is validated. Mapping is done in each host's detail view; multiple monitors from multiple sources remain distinct.
