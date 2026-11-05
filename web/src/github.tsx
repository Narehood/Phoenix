import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api";
import { useUnsavedChanges } from "./navigation";
import type {
  Collection,
  DependabotAlert,
  GitHubView,
  Project,
  PullRequest,
  WorkflowRun,
} from "./types";
import {
  Empty,
  ErrorNotice,
  Metric,
  ResponsiveDetails,
  StatusNotice,
  Time,
  Tone,
  stamp,
  useNow,
  type ToneName,
} from "./ui";

const repositoryPattern =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const slowPoll = 30000,
  fastPoll = 5000,
  fastWindow = 60000;

const stateText: Record<string, string> = {
  not_configured: "No repository is connected.",
  disabled:
    "Not polled: the source is disabled, the dependencies module is not selected, or the project is archived.",
  pending: "Configured; waiting for the first collection.",
  fresh: "Collected within 30 minutes with every source readable.",
  partial:
    "Collected recently, but some sources were unreadable or truncated. Missing parts are not healthy.",
  stale: "Older than 30 minutes or the last collection failed.",
  permission_denied: "The token lacks a required read permission.",
  not_found_or_denied:
    "The repository was not found or the token cannot see it.",
  credential_expired: "The token was rejected or has expired.",
  rate_limited: "GitHub rate limited collection; the next attempt is delayed.",
  unavailable: "GitHub could not be reached.",
  invalid_response: "GitHub returned an unexpected or oversized response.",
  request_budget_exceeded: "Collection exceeded its per-pass request budget.",
};

/** Links are server-generated under github.com; anything else is not linked. */
const safeLink = (url: string) =>
  url.startsWith("https://github.com/") ? url : undefined;
function iso(value: string) {
  if (!value) return "Unknown";
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toLocaleString();
}
function Link({ url, children }: { url: string; children: ReactNode }) {
  const href = safeLink(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

const good = new Set([
  "passing_observed",
  "approval_observed",
  "mergeable",
  "success",
]);
const bad = new Set([
  "failing",
  "conflicting",
  "changes_requested",
  "failure",
  "timed_out",
  "startup_failure",
  "critical",
  "high",
]);
const warn = new Set([
  "pending",
  "partial",
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "medium",
  "action_required",
]);
/** Retained (non-current) observations never render with a healthy tone. */
function tone(value: string, current: boolean): ToneName {
  if (bad.has(value)) return current ? "bad" : "warn";
  if (!current) return "neutral";
  return good.has(value) ? "good" : warn.has(value) ? "warn" : "neutral";
}
function sourceTone(state: string, current: boolean): ToneName {
  if (state === "fresh") return current ? "good" : "warn";
  if (["partial", "stale", "pending", "rate_limited"].includes(state))
    return "warn";
  if (["not_configured", "disabled"].includes(state)) return "neutral";
  return "bad";
}

function Coverage<T>({
  label,
  c,
  bound,
}: {
  label: string;
  c: Collection<T>;
  bound: string;
}) {
  if (c.state !== "ok")
    return (
      <p className="notice error" role="status">
        {label} could not be read ({c.state.replaceAll("_", " ")}). This is
        missing data, not an empty result.
      </p>
    );
  return c.truncated ? (
    <p className="notice">
      Truncated: more {label.toLowerCase()} exist beyond the {bound} bound.
    </p>
  ) : null;
}
function count<T>(c: Collection<T>, filter?: (t: T) => boolean) {
  if (c.state !== "ok") return "Not readable";
  const n = (c.items || []).filter(filter || (() => true)).length;
  return c.truncated ? `${n}+` : String(n);
}

function Pulls({
  title,
  items,
  current,
  empty,
}: {
  title: string;
  items: PullRequest[];
  current: boolean;
  empty: string;
}) {
  return (
    <>
      <h3 className="subhead">{title}</h3>
      {!items.length ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="table-scroll">
          <table
            role="table"
            aria-colcount={5}
            className="responsive-table pull-table"
          >
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" aria-colindex={1} scope="col">
                  Pull request
                </th>
                <th role="columnheader" aria-colindex={2} scope="col">
                  Updated
                </th>
                <th role="columnheader" aria-colindex={3} scope="col">
                  Checks
                </th>
                <th role="columnheader" aria-colindex={4} scope="col">
                  Reviews
                </th>
                <th role="columnheader" aria-colindex={5} scope="col">
                  Mergeability
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {items.map((p) => (
                <tr role="row" key={p.number}>
                  <td
                    role="cell"
                    aria-colindex={1}
                    data-label="Pull request"
                    className="wrap-cell"
                  >
                    <Link url={p.url}>
                      #{p.number} {p.title}
                    </Link>
                    <small>
                      {p.author || "unknown author"}
                      {p.draft && " · draft"}
                      {p.dependencyUpdate &&
                        ` · ${p.updateKind === "security_or_version_unclassified" ? "update kind not classified" : p.updateKind.replaceAll("_", " ")}`}
                    </small>
                  </td>
                  <td role="cell" aria-colindex={2} data-label="Updated">
                    {Number.isFinite(Date.parse(p.updatedAt)) ? (
                      <Time value={Date.parse(p.updatedAt)} />
                    ) : (
                      "Unknown"
                    )}
                  </td>
                  <td role="cell" aria-colindex={3} data-label="Checks">
                    <Tone value={p.checks} tone={tone(p.checks, current)} />
                  </td>
                  <td role="cell" aria-colindex={4} data-label="Reviews">
                    <Tone
                      value={p.reviewState}
                      tone={tone(p.reviewState, current)}
                    />
                  </td>
                  <td role="cell" aria-colindex={5} data-label="Mergeability">
                    <Tone
                      value={p.mergeable}
                      tone={
                        p.mergeable === "conflicting"
                          ? tone(p.mergeable, current)
                          : "neutral"
                      }
                      label={
                        p.mergeable === "mergeable"
                          ? "No conflicts observed"
                          : p.mergeable === "conflicting"
                            ? "Conflicts observed"
                            : "Unknown"
                      }
                    />
                    <small>Merge rules not evaluated</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Read-only GitHub health for one project. Mounted per project, so polls and
 * late responses cannot leak between projects or accounts. Missing permission,
 * failed polls and retained snapshots never render as current or healthy.
 */
export function GitHubPanel({
  project,
  permissions,
  admin,
  onVerify,
  onChanged,
}: {
  project: Project;
  permissions: string[] | null;
  admin: boolean;
  onVerify: () => void;
  onChanged: () => void;
}) {
  const canRead = !!permissions?.includes("github.read"),
    canSync = canRead && !!permissions?.includes("github.sync");
  const [view, setView] = useState<GitHubView | null>(null),
    [failed, setFailed] = useState<unknown>(null),
    [denied, setDenied] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [, setTick] = useState(0);
  const alive = useRef(true),
    seq = useRef(0),
    fastUntil = useRef(0),
    wake = useRef<() => void>(() => {});
  const path = `/api/projects/${encodeURIComponent(project.id)}/github`;

  async function load() {
    const n = ++seq.current;
    try {
      const v = await api<GitHubView>(path);
      if (!alive.current || n !== seq.current) return;
      setView(v);
      setFailed(null);
      setDenied(false);
    } catch (e) {
      if (!alive.current || n !== seq.current) return;
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        // Access was removed: discard retained repository data entirely.
        setView(null);
        setDenied(true);
        setFailed(null);
      } else setFailed(e);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!canRead) {
      seq.current++;
      setView(null);
      setFailed(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      clearTimeout(timer);
      await load();
      if (!live) return;
      setTick((t) => t + 1);
      // Replace any wake-up scheduled while this poll was in flight.
      clearTimeout(timer);
      timer = setTimeout(
        poll,
        Date.now() < fastUntil.current ? fastPoll : slowPoll,
      );
    }
    wake.current = () => {
      fastUntil.current = Date.now() + fastWindow;
      clearTimeout(timer);
      timer = setTimeout(poll, fastPoll);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
      wake.current = () => {};
    };
  }, [canRead]);

  async function sync() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await api(`${path}/sync`, "POST", {});
      if (!alive.current) return;
      setNotice(
        "Refresh scheduled. Collection runs in the background; results appear here once collected.",
      );
      wake.current();
      onChanged();
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 429)
        setNotice(
          "Refresh is cooling down (15-minute minimum per source). Collection details will show the latest refresh eligibility.",
        );
      else setError(e);
      void load();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const moduleOn = project.modules.includes("dependencies");
  const now = useNow();
  const expired =
    !!view?.collectedAt &&
    (now - view.collectedAt > 30 * 60000 || view.collectedAt > now + 30000);
  const collectionState =
    view && expired && ["fresh", "partial"].includes(view.state)
      ? "stale"
      : view?.state || "unknown";
  const current =
    !!view &&
    !failed &&
    !expired &&
    view.freshness === "fresh" &&
    (view.state === "fresh" || view.state === "partial");
  const snapshot = view?.snapshot;
  const cooling = !!view && view.nextAttemptAt > now;

  let body: ReactNode;
  if (!permissions)
    body = (
      <Empty>
        GitHub health is hidden until project permissions can be loaded.
      </Empty>
    );
  else if (!canRead || denied)
    body = (
      <Empty>
        <h3>GitHub read permission required</h3>
        <p>
          Your account does not hold github.read for this project. Project
          registry permissions do not grant private repository data.
        </p>
      </Empty>
    );
  else if (!view)
    body = failed ? (
      <div className="notice error" role="alert">
        GitHub health could not be loaded: {(failed as Error).message}
      </div>
    ) : (
      <Empty>Loading GitHub health…</Empty>
    );
  else {
    const pulls = snapshot?.pulls.items || [];
    const runs = snapshot?.defaultBranchCI.items || [];
    const alerts = snapshot?.alerts.items || [];
    body = (
      <>
        {failed ? (
          <div className="notice error" role="alert">
            Polling failed: {(failed as Error).message}. Everything below is the
            last response and is not current.
          </div>
        ) : null}
        <div className="repository-identity">
          <h3>
            {snapshot ? (
              <Link url={snapshot.repository.url}>
                {snapshot.repository.fullName}
              </Link>
            ) : (
              view.repository || "Connect a GitHub repository"
            )}
          </h3>
          <p className="muted">
            {snapshot
              ? `${snapshot.repository.private ? "Private" : "Public"} repository · ${snapshot.repository.defaultBranch || "Unknown"} branch${snapshot.repository.archived ? " · archived on GitHub" : ""}`
              : "Read-only repository checks, pull requests and security alerts."}
          </p>
        </div>
        <div className="collection-summary">
          <div className="collection-current">
            <span className="muted">
              Collected <Time value={view.collectedAt} />
            </span>
          </div>
          <details>
            <summary>Collection details</summary>
            <dl className="facts">
              <dt>Source state</dt>
              <dd>
                {failed
                  ? "Phoenix could not be reached"
                  : stateText[collectionState] ||
                    "Collection reported an error."}
              </dd>
              <dt>Last attempt</dt>
              <dd>{stamp(view.lastAttemptAt)}</dd>
              <dt>Refresh eligibility</dt>
              <dd>
                {!view.configured
                  ? "Not connected"
                  : !view.enabled ||
                      view.state === "disabled" ||
                      project.archived ||
                      !moduleOn
                    ? "Collection paused"
                    : cooling
                      ? stamp(view.nextAttemptAt)
                      : "Eligible for refresh"}
              </dd>
              <dt>Polling limit</dt>
              <dd>
                At least 15 minutes between attempts. Eligibility is not a
                promised collection time.
              </dd>
            </dl>
          </details>
        </div>
        {view.error && (
          <p className="notice error" role="status">
            Last collection error: {view.error.replaceAll("_", " ")}.{" "}
            {stateText[view.error] || ""}
          </p>
        )}
        {!snapshot ? (
          <Empty>
            {view.configured
              ? "Nothing has been observed for this repository yet. No health is implied."
              : "No repository observations exist."}
          </Empty>
        ) : (
          <>
            {!current && (
              <p className="notice retained" role="status">
                <b>Retained observation</b> collected {stamp(view.collectedAt)}.
                It is not current
                {failed
                  ? " because the dashboard could not reach Phoenix"
                  : expired
                    ? " because the collection is older than 30 minutes or its timestamp cannot be verified"
                    : ` (state: ${view.state.replaceAll("_", " ")})`}
                . Values below are last known, not current health.
              </p>
            )}
            <ResponsiveDetails
              className="observation-counts"
              label={
                <span className="bounded-counts">
                  {current ? "Observed" : "Last known"}: PRs{" "}
                  {count(snapshot.pulls)} · Updates{" "}
                  {count(snapshot.pulls, (p) => p.dependencyUpdate)} · Alerts{" "}
                  {count(snapshot.alerts)}
                  <small>10 most recent PRs · up to 50 alerts</small>
                </span>
              }
            >
              <div className="metrics health-metrics">
                <Metric
                  label="Observed PRs"
                  value={count(snapshot.pulls)}
                  detail={`10 most recent${current ? "" : " · last known"}`}
                />
                <Metric
                  label="Update PRs"
                  value={count(snapshot.pulls, (p) => p.dependencyUpdate)}
                  detail="Recognized bot authors"
                />
                <Metric
                  label="Dependabot alerts"
                  value={count(snapshot.alerts)}
                  detail={`Up to 50${current ? "" : " · last known"}`}
                />
              </div>
            </ResponsiveDetails>
            <div className="coverage-note">
              <p>
                Read-only PRs, CI and Dependabot alerts. Code/secret scanning
                unsupported; not a package-version inventory.
              </p>
              <details>
                <summary>Scope & coverage</summary>
                <p>
                  Last push {iso(snapshot.repository.pushedAt)}. Code scanning:{" "}
                  {snapshot.codeScanning}. Secret scanning:{" "}
                  {snapshot.secretScanning}. Dependency coverage is limited to
                  recognized update PRs and Dependabot alerts. Checks and
                  reviews do not evaluate required-review rules. Empty results
                  do not prove dependencies are current.
                </p>
              </details>
            </div>
            <div className="panel-body section">
              <h3>Open pull requests</h3>
              <Coverage
                label="Pull requests"
                c={snapshot.pulls}
                bound="ten-PR"
              />
              {snapshot.pulls.state === "ok" && (
                <>
                  <Pulls
                    title="Dependency update PRs"
                    items={pulls.filter((p) => p.dependencyUpdate)}
                    current={current}
                    empty="No Dependabot or Renovate PRs among the observed open PRs. Other bots and human-authored updates are not classified."
                  />
                  <Pulls
                    title="Other open PRs"
                    items={pulls.filter((p) => !p.dependencyUpdate)}
                    current={current}
                    empty="No other open PRs among those observed."
                  />
                  <p className="muted">
                    Checks need both check runs and commit statuses readable
                    before passing is observed. Reviews use each reviewer's
                    latest review on the current head. Neither evaluates branch
                    protection, CODEOWNERS or required reviews.
                  </p>
                </>
              )}
            </div>
            <div className="panel-body section">
              <h3>Default-branch CI (recent pushes)</h3>
              <Coverage
                label="Workflow runs"
                c={snapshot.defaultBranchCI}
                bound="20-run"
              />
              {snapshot.defaultBranchCI.state === "ok" &&
                (!runs.length ? (
                  <p className="muted">
                    No recent push workflow runs observed on the default branch.
                    This is not a passing result.
                  </p>
                ) : (
                  <div className="table-scroll">
                    <table
                      role="table"
                      aria-colcount={3}
                      className="responsive-table"
                    >
                      <thead role="rowgroup">
                        <tr role="row">
                          <th role="columnheader" aria-colindex={1} scope="col">
                            Workflow
                          </th>
                          <th role="columnheader" aria-colindex={2} scope="col">
                            Result
                          </th>
                          <th role="columnheader" aria-colindex={3} scope="col">
                            Commit
                          </th>
                        </tr>
                      </thead>
                      <tbody role="rowgroup">
                        {runs.map((r: WorkflowRun, i) => {
                          const result = r.conclusion || r.status || "unknown";
                          return (
                            <tr role="row" key={`${r.url}-${i}`}>
                              <td
                                role="cell"
                                aria-colindex={1}
                                data-label="Workflow"
                                className="wrap-cell"
                              >
                                <Link url={r.url}>
                                  {r.name || "Unnamed workflow"}
                                </Link>
                              </td>
                              <td
                                role="cell"
                                aria-colindex={2}
                                data-label="Result"
                              >
                                <Tone
                                  value={result}
                                  tone={tone(result, current)}
                                />
                                {r.conclusion && r.status !== "completed" && (
                                  <small>{r.status}</small>
                                )}
                              </td>
                              <td
                                role="cell"
                                aria-colindex={3}
                                data-label="Commit"
                              >
                                <code>{r.sha.slice(0, 12) || "unknown"}</code>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              <p className="muted">
                Recent history only: not the deployed version and not proof that
                every workflow passes.
              </p>
            </div>
            <div className="panel-body section">
              <h3>Dependabot alerts</h3>
              <Coverage label="Alerts" c={snapshot.alerts} bound="50-alert" />
              {snapshot.alerts.state === "ok" &&
                (!alerts.length ? (
                  <p className="muted">
                    No open Dependabot alerts reported. This does not establish
                    that installed or transitive dependencies are current.
                  </p>
                ) : (
                  <div className="table-scroll">
                    <table
                      role="table"
                      aria-colcount={4}
                      className="responsive-table"
                    >
                      <thead role="rowgroup">
                        <tr role="row">
                          <th role="columnheader" aria-colindex={1} scope="col">
                            Alert
                          </th>
                          <th role="columnheader" aria-colindex={2} scope="col">
                            Package
                          </th>
                          <th role="columnheader" aria-colindex={3} scope="col">
                            Severity
                          </th>
                          <th role="columnheader" aria-colindex={4} scope="col">
                            Fixed in
                          </th>
                        </tr>
                      </thead>
                      <tbody role="rowgroup">
                        {alerts.map((a: DependabotAlert) => (
                          <tr role="row" key={a.number}>
                            <td
                              role="cell"
                              aria-colindex={1}
                              data-label="Alert"
                              className="wrap-cell"
                            >
                              <Link url={a.url}>#{a.number}</Link>
                              <small>{a.summary}</small>
                            </td>
                            <td
                              role="cell"
                              aria-colindex={2}
                              data-label="Package"
                            >
                              {a.package}
                              <small>{a.ecosystem}</small>
                            </td>
                            <td
                              role="cell"
                              aria-colindex={3}
                              data-label="Severity"
                            >
                              <Tone
                                value={a.severity || "unknown"}
                                tone={tone(a.severity, current)}
                              />
                            </td>
                            <td
                              role="cell"
                              aria-colindex={4}
                              data-label="Fixed in"
                            >
                              {a.fixedIn || "Not supplied"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <section className="panel github">
      <div className="panel-heading github-heading">
        <h2>
          GitHub observations{" "}
          {view && canRead && !denied && (
            <Tone
              value={failed ? "unknown" : collectionState}
              tone={failed ? "neutral" : sourceTone(collectionState, current)}
              label={`Collection: ${(failed ? "unreachable" : collectionState).replaceAll("_", " ")}`}
            />
          )}
        </h2>
        <div className="button-row">
          {admin && (
            <button
              className="text-link connection-shortcut"
              onClick={() => {
                const settings = document.getElementById(
                  `repository-settings-${project.id}`,
                ) as HTMLDetailsElement | null;
                if (settings) {
                  settings.open = true;
                  settings.scrollIntoView({ block: "start" });
                  settings.querySelector("summary")?.focus();
                }
              }}
            >
              Connection settings
            </button>
          )}
          {canSync && view?.configured && (
            <button
              onClick={() => void sync()}
              disabled={
                busy ||
                !view.enabled ||
                view.state === "disabled" ||
                !moduleOn ||
                project.archived ||
                cooling
              }
              title={
                cooling
                  ? `Cooling down until ${stamp(view.nextAttemptAt)}`
                  : undefined
              }
            >
              {cooling ? "Refresh cooling down" : "Request refresh"}
            </button>
          )}
        </div>
      </div>
      <div className="panel-body github-feedback">
        <ErrorNotice
          error={error}
          onDismiss={() => setError(null)}
          onVerify={onVerify}
        />
        <StatusNotice>{notice}</StatusNotice>
        {!moduleOn && (
          <p className="notice">
            Repository health is not enabled. Open Project settings below and
            select Repository health before connecting a repository.
          </p>
        )}
        {project.archived && (
          <p className="notice">Archived projects are not polled.</p>
        )}
      </div>
      {body}
      {admin && (
        <GitHubSettings
          key={view ? "loaded" : "unloaded"}
          path={path}
          settingsId={`repository-settings-${project.id}`}
          view={canRead && !denied ? view : null}
          usable={moduleOn && !project.archived}
          onVerify={onVerify}
          onSaved={() => {
            wake.current();
            void load();
            onChanged();
          }}
          reload={load}
        />
      )}
    </section>
  );
}

function tokenProblem(token: string) {
  if (token.length < 20 || token.length > 255)
    return "Tokens are 20–255 characters.";
  if (!/^[\x21-\x7e]+$/.test(token))
    return "Tokens contain printable ASCII characters only, without spaces.";
  return "";
}

/**
 * Administrator source configuration. The token lives only in an unnamed
 * password input (never React state, storage, logs or a URL) and is cleared
 * after a successful save and on unmount.
 */
function GitHubSettings({
  path,
  settingsId,
  view,
  usable,
  onVerify,
  onSaved,
  reload,
}: {
  path: string;
  settingsId: string;
  view: GitHubView | null;
  usable: boolean;
  onVerify: () => void;
  onSaved: () => void;
  reload: () => Promise<void>;
}) {
  const [repository, setRepository] = useState(view?.repository || ""),
    [enabled, setEnabled] = useState(
      view ? view.enabled || !view.configured : true,
    ),
    [base, setBase] = useState(view?.revision ?? -1),
    [touched, setTouched] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState(!view?.configured);
  const token = useRef<HTMLInputElement>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const input = token.current;
    return () => {
      alive.current = false;
      if (input) input.value = "";
    };
  }, []);
  // Follow server changes while the form is untouched; otherwise surface them.
  useEffect(() => {
    if (!view || touched) return;
    setRepository(view.repository);
    setEnabled(view.configured ? view.enabled : true);
    setBase(view.revision);
  }, [view?.revision, view?.repository, view?.enabled, touched]);
  const conflict = !!view && touched && base !== view.revision;
  useUnsavedChanges(touched, "repository settings");
  const ready = !!view && usable && base >= 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!view || !ready || conflict || busy) return;
    const secret = token.current?.value || "";
    if (!repositoryPattern.test(repository) || /\/\.\.?$/.test(repository))
      return setError(
        new Error("Use the owner/name form of one GitHub.com repository."),
      );
    if (secret) {
      const problem = tokenProblem(secret);
      if (problem) return setError(new Error(problem));
    } else if (
      !view.configured ||
      view.repository.toLowerCase() !== repository.toLowerCase()
    )
      return setError(new Error("A token is required for a new repository."));
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const v = await api<{ configured: boolean; revision: number }>(
        path,
        "PUT",
        {
          repository,
          token: secret,
          enabled,
          revision: base,
        },
      );
      if (!alive.current) return;
      if (token.current) token.current.value = "";
      setBase(v.revision);
      setTouched(false);
      setNotice(
        `Saved source revision ${v.revision}. Previous observations were cleared; collection runs automatically.`,
      );
      onSaved();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 409) {
        setError(
          new Error(
            "The GitHub source changed since it was loaded. It has been reloaded; your input is kept. Review the current configuration before saving again.",
          ),
        );
        await reload();
      } else setError(err);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function disconnect() {
    if (!view?.configured || busy) return;
    if (
      !window.confirm(
        `Disconnect ${view.repository}? Phoenix deletes its encrypted token and cached observations. This does not revoke the token on GitHub.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await api(path, "DELETE", { revision: view.revision });
      if (!alive.current) return;
      if (token.current) token.current.value = "";
      setTouched(false);
      setNotice(
        "Disconnected. Revoke the token on GitHub if it is no longer needed.",
      );
      onSaved();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 409) {
        setError(
          new Error(
            "The GitHub source changed; it has been reloaded. Review it before disconnecting.",
          ),
        );
        await reload();
      } else setError(err);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <details
      className="disclosure settings"
      id={settingsId}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <strong>Repository settings</strong>
        <span>Connection and read-only credentials</span>
      </summary>
      <div className="panel-body">
        <p className="muted">
          Administrator only; saving requires recent password and MFA
          verification. Use a fine-grained token limited to this repository with
          read access to metadata, pull requests, checks, commit statuses,
          Actions and Dependabot alerts. Phoenix only reads.
        </p>
        <ErrorNotice
          error={error}
          onDismiss={() => setError(null)}
          onVerify={onVerify}
        />
        <StatusNotice>{notice}</StatusNotice>
        {!view ? (
          <p className="muted">
            Settings are available once the source state has loaded.
          </p>
        ) : !usable ? (
          <p className="muted">
            Enable Repository health in Project settings on an active project
            before connecting a repository.
          </p>
        ) : null}
        {conflict && view && (
          <div className="notice conflict" role="alert">
            <b>
              Source revision {view.revision} replaced revision {base}.
            </b>
            <p>
              Current: {view.configured ? view.repository : "not configured"}
              {view.configured && ` · ${view.enabled ? "enabled" : "disabled"}`}
              . Your input: {repository || "(empty)"} ·{" "}
              {enabled ? "enabled" : "disabled"}.
            </p>
            <div className="button-row">
              <button type="button" onClick={() => setBase(view.revision)}>
                Keep my input on revision {view.revision}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (token.current) token.current.value = "";
                  setTouched(false);
                }}
              >
                Discard my input
              </button>
            </div>
          </div>
        )}
        <form
          className="form"
          onSubmit={submit}
          aria-label="GitHub source settings"
        >
          <fieldset disabled={!ready || busy}>
            <legend>
              {view?.configured
                ? `Connected · revision ${view.revision}`
                : "Connect a repository"}
            </legend>
            <label>
              Repository (owner/name)
              <input
                name="repository"
                value={repository}
                autoComplete="off"
                spellCheck={false}
                maxLength={140}
                onChange={(e) => {
                  setRepository(e.target.value.trim());
                  setTouched(true);
                }}
              />
            </label>
            <label>
              {view?.configured
                ? "Replacement token (optional)"
                : "Read-only token"}
              <input
                ref={token}
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={255}
                data-secret="github-token"
                onChange={() => setTouched(true)}
              />
              <small>
                {view?.configured
                  ? "Leave blank to keep the stored token for the same repository. A different repository requires a token."
                  : "Stored encrypted on the server and never shown again."}
              </small>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  setEnabled(e.target.checked);
                  setTouched(true);
                }}
              />
              Collect automatically
            </label>
          </fieldset>
          <div className="button-row">
            <button className="primary" disabled={!ready || busy || conflict}>
              {busy
                ? "Working…"
                : view?.configured
                  ? "Save source"
                  : "Connect repository"}
            </button>
            {view?.configured && (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void disconnect()}
              >
                Disconnect
              </button>
            )}
          </div>
        </form>
      </div>
    </details>
  );
}
