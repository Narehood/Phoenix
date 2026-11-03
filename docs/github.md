# GitHub project health

This is a read-only GitHub.com integration. Operators register their own projects
and an administrator connects one repository per project. Nothing is preseeded.
Enterprise origins, GitHub App token issuance, writes, package-manifest/version
resolution, deployments, code-scanning and secret-scanning collectors are outside
this slice. Those scanning sources are explicitly `unsupported`.

Select the project's `dependencies` module, then configure its repository through
the interface. Use a repository-scoped fine-grained token with read permissions
for metadata, pull requests, checks, commit statuses, Actions and Dependabot alerts.
Only grant the selected repository. Phoenix uses GET requests only, encrypts the
token in its existing server vault and never returns it in API responses. GitHub
permission gaps remain explicit rather than appearing as zero findings. Token
issuance/rotation is operator managed; Phoenix does not inspect an existing local
Git credential store or environment file.

## Browser API and frontend contract

Existing TLS sessions and mutation Origin/CSRF rules apply. Project read is a
prerequisite to these routes. Registry metadata permissions and GitHub permissions
are separate. New project-scoped grants are `github.read` and `github.sync`;
viewers may use only the read action. Administrators configure/disconnect sources.

- GET `/api/projects/{id}/github`: requires `github.read`; returns `GitHubView` below.
- PUT `/api/projects/{id}/github`: admin + recent MFA; body
  `{repository:"owner/name",token:"...",enabled:true,revision:0}` for first setup.
  Returns `{configured:true,revision:1}`. Existing source edits must provide its
  current revision, including the retained revision after disconnect. A blank
  token retains it only for the same connected repository. New
  repositories require a token. Any accepted edit clears previous observations.
- DELETE `/api/projects/{id}/github`: admin + recent MFA; JSON `{revision:1}`;
  removes encrypted credentials and cached observations, retaining only an empty
  revision tombstone. HTTP 409 on a stale revision. Returns
  `{disconnected:true,revision:<next revision>}`. Reconnect using the current
  revision from GET, never resetting to zero. This is not GitHub-side token revocation.
- POST `/api/projects/{id}/github/sync`: requires both `github.read` and
  `github.sync`; returns HTTP 202 `{scheduled:true}` or HTTP 429 while cooling
  down. Reads never dispatch collection. Collection also runs automatically.

Source configure/delete bodies are capped at 2 KiB/1 KiB. There are at most 16
configured sources (including disabled sources), one per project. Disconnected
revision tombstones do not consume these slots and are bounded by the 100 projects.
The source revision is independent of project metadata revision. Source events
share the project's bounded audit history. Source state is polled separately
from host and Canary state.

`GET /api/projects/{id}/capabilities` now also supplies `permissions:string[]`
from `project.read`, `project.manage`, `github.read`, `github.sync`. Clients should
use those effective permissions to show controls; admin-only source configuration
additionally uses the session role. The dependency module reflects source state;
other selected modules remain unsupported. Capability `actions` remain empty:
this collector cannot update dependencies or publish anything.

```ts
type GitHubView = {
  configured: boolean; repository: string; enabled: boolean; revision: number;
  state: string; freshness: "unknown" | "fresh" | "stale"; error: string;
  lastAttemptAt: number; collectedAt: number; nextAttemptAt: number;
  snapshot: Snapshot | null;
};
type Collection<T> = { state: string; truncated: boolean; items: T[] };
type Snapshot = {
  repository: {fullName:string; url:string; private:boolean; archived:boolean;
    defaultBranch:string; pushedAt:string};
  pulls: Collection<{number:number; title:string; url:string; author:string;
    draft:boolean; updatedAt:string; dependencyUpdate:boolean; updateKind:string;
    mergeable:string; reviewState:string; checks:string}>;
  defaultBranchCI: Collection<{name:string; url:string; status:string;
    conclusion:string; sha:string}>;
  alerts: Collection<{number:number; package:string; ecosystem:string;
    severity:string; summary:string; fixedIn:string; url:string}>;
  codeScanning:"unsupported"; secretScanning:"unsupported";
  dependencyCoverage:"update_prs_and_dependabot_alerts_only";
};
```

Outer timestamps are Unix milliseconds; upstream `pushedAt`/`updatedAt` are ISO
timestamps. Repository names and displayed strings are untrusted text. Links
are generated server-side under `https://github.com/`; no upstream arbitrary
link is forwarded. Tokens must never enter browser storage, URLs or logs.

## Meaning and limits

The server polls serially with a 15-minute minimum interval per source. Refresh
requests cannot bypass this cooldown. Attempts claim their next time before
network work, so restarts do not remove the bound. Source configuration changes
invalidate in-flight writes. Disabled sources, archived projects and disabled
dependency modules are not polled, and late observations cannot reactivate them.
Freshness expires after 30 minutes or any collection error.

Each pass has a 60-second deadline, at most 64 GETs, 8-second request timeouts,
2 MiB per upstream response and 256 KiB per normalized snapshot. Redirects are
refused, including same-origin redirects. Only `https://api.github.com` is used.
Rate-limit reset/Retry-After extends the durable cooldown up to 24 hours.

The view state is `not_configured`, `disabled`, `pending`, `fresh`, `partial`,
`stale` or a sanitized error such as `permission_denied`, `not_found_or_denied`,
`credential_expired`, `rate_limited`, `unavailable`, `invalid_response`,
`request_budget_exceeded`. A snapshot may remain visible during an error; it must
be marked as retained/stale. Missing data must not render as healthy.

Collections have `state:"ok"` or an explicit error. `truncated:true` means
more results exist beyond the bound. The collector reads the ten most recently
updated open PRs, 100 reviews/checks/statuses per PR, 20 recent default-branch
push workflow runs and 50 open Dependabot alerts. It detects pagination and
marks truncation rather than claiming completeness. It never follows upstream
pagination URLs. An otherwise readable recent-CI window does not make the whole
source partial merely because older runs exist; its truncation flag stays visible.
Default-branch runs are recent history, not the currently
deployed version or a claim that every workflow passes.

PR check summaries are `passing_observed`, `failing`, `pending`, `not_reported`,
`partial`, `unknown`. Both check runs and legacy commit statuses must be readable
before a passing observation is possible. This is not branch-protection approval.
Mergeability is `mergeable`, `conflicting`, `unknown`; unknown is preserved while
GitHub computes it. Review summaries are `changes_requested`, `approval_observed`,
`no_current_approval`, `partial`, `unknown`. They use the latest non-comment review
per reviewer; an old-head approval is not counted as a current approval. They do
not evaluate CODEOWNERS or required-review policy.

Recognized Dependabot/Renovate author identities mark dependency update PRs.
`updateKind:"security_or_version_unclassified"` deliberately does not infer
security versus routine updates from titles. Other bot identities and human-authored
updates are not automatically classified. Dependabot alerts are a separate source
of known vulnerabilities, with fixed versions when supplied. An empty PR/alert list
does not establish that installed, transitive or source dependencies are current.

Official source contracts: [pull requests](https://docs.github.com/en/rest/pulls/pulls),
[reviews](https://docs.github.com/en/rest/pulls/reviews),
[check runs](https://docs.github.com/en/rest/checks/runs),
[commit statuses](https://docs.github.com/en/rest/commits/statuses),
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[Dependabot alerts](https://docs.github.com/en/rest/dependabot/alerts).
