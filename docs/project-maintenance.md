# Project maintenance

Phoenix is gaining a reusable maintenance workspace alongside host management.
Operators register their own projects; the open-source installation contains no
preconfigured projects, repositories, application-specific schemas or credentials.
Canary remains independent. A project is not a host: registration does not enroll
an agent or authorize access to an application's data.

The current slice includes browser registration, metadata editing, archiving,
explicit project grants, bounded audit history and versioned module availability,
plus the [read-only GitHub.com connector](github.md). The installation stays empty
until an operator registers projects and connects repositories. The frontend was
implemented by the user's requested Opus 5.5 High agent.

## Delivery order

1. Project foundation (this slice).
2. Read-only GitHub health and dependency-update visibility (this slice):
   operator-selected repositories, PR/review and CI status, security findings and
   update PRs, with explicit coverage and freshness. The requirements in
   [milestone.md](milestone.md#github-repository-health--planned) still apply.
3. Searchable project documentation with editing, revisions, separate public/private
   access and portable recovery exports.
4. Schema-based content tools and application connectors that preserve application
   authorization, validation and publishing rules.
5. Update preparation, approved release jobs, backup visibility and recovery.

Steps 3–5 are planned. No update engine is selected or enabled by this slice.
An empty update-PR list cannot establish that all dependencies are current.
Application schemas and real projects are operator supplied. Phoenix itself may
be registered by its operator and needs an external recovery path.

Routine maintenance must eventually use web interfaces; documented terminal
commands are acceptable for emergency recovery. The existing Debian/systemd,
browser, security and production acceptance gates remain in force.

## Project API

All routes use existing TLS browser sessions. Mutations require the configured
Origin, `X-CSRF-Token` and password/MFA authentication within five minutes.
Unknown JSON fields are rejected. Project bodies are capped at 8 KiB and contain
metadata only, never credentials, commands or connection URLs.

| Method and route | Behavior and authorization |
| --- | --- |
| GET `/api/projects` | `{projects:[...]}`; only projects with `project.read`, including archives; new installations return `{projects:[]}` |
| POST `/api/projects` | Administrator + recent authentication; register an immutable ID; HTTP 201 with project |
| GET `/api/projects/{project}` | Project metadata; `project.read` |
| PUT `/api/projects/{project}` | Replace mutable metadata with matching `revision`; both `project.read` and `project.manage`, plus recent authentication |
| GET `/api/projects/{project}/capabilities` | Versioned module availability; `project.read` |
| GET `/api/projects/{project}/audit` | `{events:[{at,actor,action,revision}]}`; newest 100; `project.read`; actor is a Phoenix user ID |

Absent and unreadable IDs both return HTTP 404 for detail, capabilities, audit
and valid update requests. A readable project without manage permission returns
HTTP 403 on update. HTTP 409 means duplicate ID, capacity reached or stale save;
clients must reload and resolve conflicts without silently overwriting them.

Registration body (generic example, not a seeded project):

```json
{
  "id": "example-project",
  "name": "Example project",
  "description": "Operator-supplied maintenance inventory",
  "modules": ["dependencies", "documentation"]
}
```

IDs match `[a-z0-9][a-z0-9-]{0,63}` and remain immutable. Names use Phoenix's
existing 1–80 character ASCII name format without surrounding whitespace.
Descriptions are at most 2,048 UTF-8 bytes; newline and tab are the only allowed
control characters. Modules must be distinct known IDs. Omitted/null modules
normalize to an empty array; none are selected automatically.

The response adds `archived:false`, `revision:1`, `createdAt` and `updatedAt`
(UTC Unix milliseconds). Updates supply the complete mutable metadata and the
last-read revision:

```json
{
  "name": "Example project",
  "description": "Operator-supplied maintenance inventory",
  "modules": ["dependencies"],
  "archived": false,
  "revision": 1
}
```

Every accepted update increments the revision. Archive with `archived:true`;
restore with `false`. Archives remain readable to authorized users. There is no
delete/reuse operation, so retained grants cannot transfer to a different project.
Capacity is 100 projects, including archives; deletion policy is future work.

Writes and audit entries commit in one SQLite transaction. The database retains
the newest 100 events per project (at most 10,000 registry events). Rejected
requests add no project event. History does not retain old field values or offer
unlimited compliance retention. Tables initialize idempotently on database open;
no import/seed command is needed. Standard SQLite backups include them.

## Permissions

Administrators manage the registry. Operators/viewers need explicit grants through
the existing admin-only, recent-authenticated grant-replacement endpoint:

```json
{
  "grants": [
    {"scopeType":"project","scope":"example-project","action":"project.read"},
    {"scopeType":"project","scope":"example-project","action":"project.manage"}
  ]
}
```

Replacement still replaces **all** target-user grants; clients must preserve
intended host grants. Project scopes require registered IDs. A `*` action within
one project covers registry and GitHub read/sync actions. Viewers can only read, even
with that wildcard. `project.manage` alone does not grant read. Access is checked
on every request, and update permission is checked inside its transaction.

`github.read` is separate from metadata access; `github.sync` additionally allows
requesting bounded background collection. Administrators configure sources with
recent authentication. The grant editor loads the complete set using admin-only
GET `/api/users/{user}/grants`, then preserves intended host/project grants while
editing. A failed load disables replacement. Replacement includes the loaded
set as `expectedGrants`; the server compares it inside the replacement transaction
and rejects a stale set with 409. The editor keeps the draft and can reapply only
its explicit additions/removals to the latest set for review, or discard it and
load the latest set. Neither choice saves automatically. A concurrent revocation
is not restored merely because it was present in the earlier loaded set.

Existing host/group/all grants, including fleet-wide wildcards, confer no project
access. Project grants confer no host access. Cross-category grants are rejected.
Registry permissions do not authorize private application data, financial books,
publishing, deployment or restore; future modules need separate permissions and
must preserve the connected application's authorization.

## Capability contract v1

`contractVersion:1` is independent of the agent protocol. Responses contain
`projectId`, metadata `revision` and five `modules`: `documentation`, `dependencies`,
`content`, `releases`, `operations`. Each entry has `id`, `enabled`, `state`,
`reason`, `actions`.

- Unselected: `enabled:false`, `state:"disabled"`, `reason:"module_disabled"`.
- Selected documentation/content/releases/operations: `enabled:true`,
  `state:"unsupported"`, `reason:"connector_not_implemented"`.
- Selected dependencies: GitHub source state, or explicit not-configured/denied;
  see [GitHub](github.md). Effective grants are also returned as `permissions`.
- Archived: every module has `state:"disabled"`, `reason:"project_archived"`;
  selected flags remain for restoration.
- Actions are empty arrays. Module selection alone does not contact providers
  or enable writes. A separately configured, enabled GitHub source is collected.

The GitHub connector implements read-only collection with server-encrypted
credentials. Write connectors, content input schemas, jobs and publication remain
future work. Connectors must declare their version,
capabilities, permission/prerequisite checks, validation, execution, verification
and failure/uncertainty semantics. Collectors need server-side credentials,
bounded responses/polling and explicit missing-permission, disabled, unsupported,
stale and rate-limited states. Arbitrary shell commands or executable plugins
are not part of this contract.

## Frontend handoff and validation

The dashboard includes empty inventory, administrator registration, scoped details,
revision conflicts with explicit keep/discard choices, archive/restore, capability
availability, audit history and a grant editor preserving host/project grants.
Names/descriptions render as untrusted text. Unsupported capabilities do not offer
actions. See [protocol.md](protocol.md) and [GitHub](github.md) for API details.

New runtime fixtures use fresh temporary databases/identities and cover empty
registration, persistence, archive/restore, stale saves, host/project isolation,
viewer ceilings, permission changes within a session, Origin/CSRF/recent-authentication,
invalid input, capacity and audit bounds. Execution evidence is recorded separately
in [validation.md](validation.md).
