import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import type { Grant, Host, Project, User } from "./types";
import { Empty, ErrorNotice, StatusNotice } from "./ui";
import { useUnsavedChanges } from "./navigation";

const actionLabels: Record<string, string> = {
  "host.read": "View host status",
  "host.manage": "Edit host details",
  diagnostic: "Run diagnostics",
  "services.inspect": "Inspect services",
  "logs.read": "Read service logs",
  "service.restart": "Restart allowed services",
  "host.reboot": "Request a reboot",
  "jobs.output": "View job output",
  "jobs.cancel": "Cancel jobs",
  "project.read": "View project",
  "project.manage": "Edit project details",
  "github.read": "View repository observations",
  "github.sync": "Refresh repository observations",
};

const hostActions = [
  "host.read",
  "host.manage",
  "diagnostic",
  "services.inspect",
  "logs.read",
  "service.restart",
  "host.reboot",
  "jobs.output",
  "jobs.cancel",
];
const projectActions = [
  "project.read",
  "project.manage",
  "github.read",
  "github.sync",
];
const viewerActions = ["host.read", "project.read", "github.read"];
const hostActionGroups: [string, string[]][] = [
  ["Observe", ["host.read", "services.inspect", "logs.read", "jobs.output"]],
  ["Operate", ["diagnostic", "service.restart", "jobs.cancel"]],
  ["Manage", ["host.manage", "host.reboot"]],
];
const projectActionGroups: [string, string[]][] = [
  ["Project details", ["project.read", "project.manage"]],
  ["Repository observations", ["github.read", "github.sync"]],
];
const grantLimit = 100;
const key = (g: Grant) => `${g.scopeType}\u0000${g.scope}\u0000${g.action}`;

type Load =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed"; error: unknown }
  | { state: "loaded"; grants: Grant[] };

/**
 * Grant replacement is all-or-nothing on the server, so the complete current set
 * is loaded first and edited as a whole. Mutation stays disabled until that load
 * succeeds; responses for a previously selected account are discarded.
 */
export function GrantEditor({
  users,
  hosts,
  usersLoaded,
  usersLoading = false,
  onVerify,
}: {
  users: User[];
  hosts: Host[];
  usersLoaded: boolean;
  usersLoading?: boolean;
  onVerify: () => void;
}) {
  const [userId, setUserId] = useState(""),
    [load, setLoad] = useState<Load>({ state: "idle" }),
    [working, setWorking] = useState<Grant[]>([]),
    [projects, setProjects] = useState<Project[] | null>(null),
    [projectsError, setProjectsError] = useState(""),
    [scopeType, setScopeType] = useState("host"),
    [scope, setScope] = useState(""),
    [manualTarget, setManualTarget] = useState(false),
    [actions, setActions] = useState<string[]>([]),
    [error, setError] = useState<unknown>(null),
    [conflict, setConflict] = useState(false),
    [latest, setLatest] = useState<Grant[] | null>(null),
    [latestError, setLatestError] = useState<unknown>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const current = useRef(""),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    api<{ projects: Project[] }>("/api/projects")
      .then((v) => alive.current && setProjects(v.projects))
      .catch((e) => alive.current && setProjectsError((e as Error).message));
    return () => {
      alive.current = false;
    };
  }, []);
  const account = users.find((u) => u.id === userId);
  const viewer = account?.role === "viewer";

  async function fetchGrants(id: string) {
    current.current = id;
    setLoad({ state: "loading" });
    setWorking([]);
    try {
      const v = await api<{ grants: Grant[] | null }>(
        `/api/users/${encodeURIComponent(id)}/grants`,
      );
      if (!alive.current || current.current !== id) return;
      const grants = v.grants || [];
      setLoad({ state: "loaded", grants });
      setWorking(grants);
    } catch (e) {
      if (!alive.current || current.current !== id) return;
      setLoad({ state: "failed", error: e });
    }
  }
  function choose(id: string, force = false) {
    if (busy && !force) return;
    if (
      !force &&
      id !== userId &&
      changed &&
      !window.confirm(
        "Discard unsaved permission changes before selecting another account?",
      )
    )
      return;
    setUserId(id);
    setError(null);
    setNotice("");
    setConflict(false);
    setLatest(null);
    setLatestError(null);
    setActions([]);
    if (!id) {
      current.current = "";
      setLoad({ state: "idle" });
      setWorking([]);
      return;
    }
    void fetchGrants(id);
  }
  // Drop a selection whose account disappeared from the list.
  useEffect(() => {
    if (userId && usersLoaded && !users.some((u) => u.id === userId))
      choose("", true);
  }, [users, usersLoaded]);

  const loaded = load.state === "loaded" ? load.grants : null;
  const saved = new Set((loaded || []).map(key)),
    pending = new Set(working.map(key));
  const additions = working.filter((g) => !saved.has(key(g))),
    removals = (loaded || []).filter((g) => !pending.has(key(g)));
  const added = additions.length,
    removed = removals.length;
  const changed = added + removed > 0;
  useUnsavedChanges(changed || busy, "account permissions");
  const editingBlocked = busy || conflict;
  const groups = [...new Set(hosts.flatMap((host) => host.groups))].sort();
  const available = scopeType === "project" ? projectActions : hostActions;
  const actionGroups =
    scopeType === "project" ? projectActionGroups : hostActionGroups;

  function addGrants() {
    if (!loaded || editingBlocked) return;
    setError(null);
    setNotice("");
    const target = scopeType === "all" ? "*" : scope.trim();
    if (!target) return setError(new Error("Choose a scope first."));
    if (scopeType !== "project" && target.length > 80)
      return setError(
        new Error("Host IDs and group names are at most 80 characters."),
      );
    if (!actions.length)
      return setError(new Error("Select at least one action."));
    const additions = actions
      .map((action) => ({ scopeType, scope: target, action }))
      .filter((g) => !pending.has(key(g)));
    if (working.length + additions.length > grantLimit)
      return setError(
        new Error(`An account can hold at most ${grantLimit} grants.`),
      );
    setWorking((w) => [...w, ...additions]);
    setActions([]);
  }

  async function readLatest(id = userId) {
    setBusy(true);
    setLatestError(null);
    try {
      const response = await api<{ grants: Grant[] | null }>(
        `/api/users/${encodeURIComponent(id)}/grants`,
      );
      if (alive.current && current.current === id)
        setLatest(response.grants || []);
    } catch (err) {
      if (alive.current && current.current === id) setLatestError(err);
    } finally {
      if (alive.current && current.current === id) setBusy(false);
    }
  }
  function resolveConflict(reapply: boolean) {
    if (!latest || busy) return;
    const removedKeys = new Set(removals.map(key));
    const next = reapply
      ? latest.filter((g) => !removedKeys.has(key(g)))
      : [...latest];
    const nextKeys = new Set(next.map(key));
    if (reapply) next.push(...additions.filter((g) => !nextKeys.has(key(g))));
    if (next.length > grantLimit) {
      setLatestError(
        new Error(
          "The combined set exceeds 100 grants. Load the latest set, then edit it again.",
        ),
      );
      return;
    }
    setLoad({ state: "loaded", grants: latest });
    setWorking(next);
    setLatest(null);
    setConflict(false);
    setLatestError(null);
    setError(null);
    setNotice(
      reapply
        ? "Your additions and removals were reapplied to the latest saved grants. Review changes before saving."
        : "Latest saved grants loaded. Your previous draft was discarded.",
    );
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const id = userId;
    if (!id || !account || !loaded || !changed || editingBlocked) return;
    if (
      !window.confirm(
        `Replace ALL grants for ${account.name}? The account will hold exactly ${working.length} grant(s): ${added} added, ${removed} removed.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await api(`/api/users/${encodeURIComponent(id)}/grants`, "PUT", {
        grants: working,
        expectedGrants: loaded,
      });
      if (!alive.current || current.current !== id) return;
      setNotice(`Grants replaced for ${account.name}.`);
      await fetchGrants(id);
    } catch (err) {
      if (alive.current && current.current === id) {
        if (err instanceof ApiError && err.status === 409) {
          setConflict(true);
          await readLatest(id);
        } else setError(err);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name;
  const scopeName = (grant: Grant) =>
    grant.scopeType === "project"
      ? projectName(grant.scope)
      : grant.scopeType === "host"
        ? hosts.find((host) => host.id === grant.scope)?.name
        : undefined;
  const sorted = [...working].sort((a, b) => key(a).localeCompare(key(b)));
  return (
    <form className="form grant-editor" onSubmit={submit} aria-busy={busy}>
      <p className="muted grant-instructions">
        Choose an account, then edit its working grant set.
      </p>
      <div className="grant-workspace">
        <div className="grant-current">
          <label>
            Account
            <select
              name="user"
              required
              disabled={busy}
              value={userId}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">
                {usersLoaded
                  ? "Select an account"
                  : usersLoading
                    ? "Loading accounts…"
                    : "Accounts unavailable"}
              </option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </label>
          {load.state === "loading" && (
            <p className="muted" role="status">
              Loading current grants…
            </p>
          )}
          {load.state === "failed" && (
            <div className="notice error" role="alert">
              <span>
                Current grants could not be loaded:{" "}
                {(load.error as Error).message}. Replacement is disabled so
                existing grants cannot be overwritten blindly.
              </span>
              <button type="button" onClick={() => void fetchGrants(userId)}>
                Retry
              </button>
            </div>
          )}
          {loaded && (
            <div className="grant-list">
              <p className="muted">
                {working.length} of at most {grantLimit} grants
                {changed ? " · unsaved" : ""}
              </p>
              {!working.length ? (
                <p className="muted">
                  {changed
                    ? "The working set is empty. Replace grants to remove all saved access."
                    : "This account holds no grants."}
                </p>
              ) : (
                <div className="table-scroll bounded">
                  <table>
                    <thead>
                      <tr>
                        <th>Scope</th>
                        <th>Action</th>
                        <th>
                          <span className="sr-only">Remove</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((g) => (
                        <tr
                          key={key(g)}
                          data-grant={`${g.scopeType}:${g.scope}:${g.action}`}
                        >
                          <td>
                            <span className="tag">{g.scopeType}</span>{" "}
                            {scopeName(g) || <code>{g.scope}</code>}
                            {scopeName(g) && scopeName(g) !== g.scope && (
                              <small>
                                <code>{g.scope}</code>
                              </small>
                            )}
                            {g.scopeType === "project" && !scopeName(g) && (
                              <small>
                                {projects ? "Project unavailable" : ""}
                              </small>
                            )}
                          </td>
                          <td>
                            {g.action === "*"
                              ? "All actions"
                              : actionLabels[g.action] || g.action}
                            <small>
                              <code>{g.action}</code>
                            </small>
                            {g.action === "host.manage" &&
                              account?.role !== "admin" && (
                                <small>
                                  Administrator only; this account cannot edit
                                  host details.
                                </small>
                              )}
                            {!saved.has(key(g)) && (
                              <small>Added · unsaved</small>
                            )}
                          </td>
                          <td>
                            <button
                              type="button"
                              disabled={editingBlocked}
                              aria-label={`Remove ${g.action} on ${g.scopeType} ${g.scope}`}
                              onClick={() =>
                                setWorking((w) =>
                                  w.filter((x) => key(x) !== key(g)),
                                )
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
        {!loaded && (
          <Empty>
            {load.state === "loading"
              ? "Loading the complete grant set before editing…"
              : load.state === "failed"
                ? "Retry loading current grants before editing permissions."
                : "Select an account to view its complete grant set and edit permissions."}
          </Empty>
        )}
        <fieldset
          className="grant-add"
          disabled={!loaded || editingBlocked}
          hidden={!loaded}
        >
          <legend>Add grants to the working set</legend>
          <div className="grant-targets">
            <label>
              Scope type
              <select
                name="scopeType"
                value={scopeType}
                onChange={(e) => {
                  setScopeType(e.target.value);
                  setScope("");
                  setManualTarget(false);
                  setActions([]);
                }}
              >
                <option value="host">Host</option>
                <option value="group">Group</option>
                <option value="all">All hosts (*)</option>
                <option value="project" disabled={!projects?.length}>
                  Project
                </option>
              </select>
              {projectsError && (
                <small className="error">
                  Projects could not be loaded ({projectsError}); project scopes
                  cannot be added. Existing project grants are preserved.
                </small>
              )}
              {projects && !projects.length && (
                <small>
                  Register a project before granting project access.
                </small>
              )}
            </label>
            {scopeType === "project" ? (
              <label>
                Project
                <select
                  name="projectScope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="">Select a project</option>
                  {(projects || []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id}){p.archived ? " · archived" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                {scopeType !== "all" && (
                  <label>
                    {scopeType === "host" ? "Host" : "Group"}
                    <select
                      name="grantTarget"
                      value={manualTarget ? "__manual__" : scope}
                      onChange={(event) => {
                        setManualTarget(event.target.value === "__manual__");
                        setScope(
                          event.target.value === "__manual__"
                            ? ""
                            : event.target.value,
                        );
                      }}
                    >
                      <option value="">
                        Select {scopeType === "host" ? "a host" : "a group"}
                      </option>
                      {scopeType === "host"
                        ? hosts.map((host) => (
                            <option key={host.id} value={host.id}>
                              {host.name} ({host.id})
                            </option>
                          ))
                        : groups.map((group) => (
                            <option key={group} value={group}>
                              {group}
                            </option>
                          ))}
                      <option value="__manual__">
                        Enter{" "}
                        {scopeType === "host" ? "a host ID" : "a group name"}{" "}
                        manually
                      </option>
                    </select>
                  </label>
                )}
                <label hidden={scopeType !== "all" && !manualTarget}>
                  {scopeType === "all"
                    ? "All hosts"
                    : scopeType === "host"
                      ? "Host ID"
                      : "Group name"}
                  <input
                    name="scope"
                    autoComplete="off"
                    maxLength={80}
                    value={scopeType === "all" ? "*" : scope}
                    readOnly={scopeType === "all"}
                    onChange={(e) => setScope(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>
          <div className="check-grid" role="group" aria-label="Actions">
            {actionGroups.map(([group, items]) => (
              <fieldset className="permission-group" key={group}>
                <legend>{group}</legend>
                {items.map((a) => {
                  const administratorOnly =
                    a === "host.manage" && account?.role !== "admin";
                  const blocked =
                    administratorOnly || (viewer && !viewerActions.includes(a));
                  return (
                    <label className="check" key={a}>
                      <input
                        type="checkbox"
                        value={a}
                        disabled={blocked}
                        checked={actions.includes(a)}
                        onChange={(e) =>
                          setActions((v) =>
                            e.target.checked
                              ? [...v, a]
                              : v.filter((x) => x !== a),
                          )
                        }
                      />
                      <span>
                        {actionLabels[a] || a}
                        {administratorOnly && (
                          <small className="permission-limit">
                            Administrator only
                          </small>
                        )}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>
          <details className="permission-reference">
            <summary>Permission identifiers</summary>
            <dl>
              {available.map((action) => (
                <div key={action}>
                  <dt>{actionLabels[action]}</dt>
                  <dd>
                    <code>{action}</code>
                  </dd>
                </div>
              ))}
            </dl>
          </details>
          <small>
            {scopeType === "project"
              ? "Editing project details does not grant read access. Repository observations require their own read permission; refresh also requires it."
              : "Host, group and all-host grants confer no project access."}
            {viewer && " Viewers are limited to read actions."}
          </small>
          <button type="button" onClick={addGrants}>
            Add to working set
          </button>
        </fieldset>
      </div>
      <div className="grant-save" hidden={!loaded && !error && !notice}>
        {conflict && (
          <section
            className="notice retained grant-conflict"
            aria-label="Grant conflict"
          >
            <p role="status">
              Saved grants changed. Your earlier draft is kept; choose how to
              continue.
            </p>
            {busy && <p role="status">Loading latest grants…</p>}
            {latest && (
              <>
                <details>
                  <summary>Latest saved grants ({latest.length})</summary>
                  {latest.length ? (
                    <ul className="grant-latest-list">
                      {latest.map((grant) => (
                        <li key={key(grant)}>
                          {actionLabels[grant.action] || grant.action} ·{" "}
                          {grant.scopeType === "all"
                            ? "All hosts"
                            : `${grant.scopeType === "project" ? "Project" : grant.scopeType === "host" ? "Host" : "Group"}: ${scopeName(grant) || grant.scope}`}
                          {grant.scopeType !== "all" && (
                            <>
                              {" "}
                              · ID: <code>{grant.scope}</code>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No grants in the latest saved set.</p>
                  )}
                </details>
                <p>
                  Reapply your additions and removals to the latest set,
                  preserving other saved changes. Review the result before
                  saving.
                </p>
                <div className="button-row">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => resolveConflict(true)}
                  >
                    Reapply my changes for review
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => resolveConflict(false)}
                  >
                    Discard my draft and load latest
                  </button>
                </div>
              </>
            )}
            <ErrorNotice
              error={latestError}
              onDismiss={() => setLatestError(null)}
            />
            {!latest && !busy && (
              <button type="button" onClick={() => void readLatest()}>
                Retry latest grants
              </button>
            )}
          </section>
        )}
        {changed && (
          <details className="grant-change-review" open>
            <summary>
              {conflict ? "Earlier draft" : "Review changes"} · {added} added ·{" "}
              {removed} removed
            </summary>
            <div className="grant-change-columns">
              {[
                { label: "Adding", grants: additions },
                { label: "Removing", grants: removals },
              ].map(({ label, grants }) => (
                <section key={label}>
                  <h3>
                    {label} ({grants.length})
                  </h3>
                  {grants.length ? (
                    <ul>
                      {grants.map((grant) => (
                        <li key={key(grant)}>
                          <strong>
                            {actionLabels[grant.action] || grant.action}
                          </strong>
                          <span>
                            {grant.scopeType === "all"
                              ? "All hosts"
                              : `${grant.scopeType === "project" ? "Project" : grant.scopeType === "host" ? "Host" : "Group"}: ${scopeName(grant) || grant.scope}`}
                          </span>
                          {["host", "project"].includes(grant.scopeType) && (
                            <small>
                              {grant.scopeType === "host" ? "Host" : "Project"}{" "}
                              ID: <code>{grant.scope}</code>
                            </small>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>None</p>
                  )}
                </section>
              ))}
            </div>
          </details>
        )}
        <ErrorNotice
          error={error}
          onDismiss={() => setError(null)}
          onVerify={onVerify}
        />
        <StatusNotice>{notice}</StatusNotice>
        <div className="grant-save-summary">
          <p className="grant-save-account">
            {account ? (
              <>
                <strong>{account.name}</strong> ·{" "}
                {load.state === "loading"
                  ? "Loading grants…"
                  : loaded
                    ? working.length + " grants in the working set"
                    : "Grants unavailable"}
              </>
            ) : (
              "Select an account to edit its grants."
            )}
          </p>
          <small>
            Saving replaces every grant this account holds with the list above,
            including host and project grants.
          </small>
          <small role="status">
            {conflict
              ? "Resolve the saved-set conflict before saving."
              : !loaded
                ? load.state === "loading"
                  ? "Loading the complete grant set…"
                  : "Load current grants before making a replacement."
                : !changed
                  ? "No unsaved changes."
                  : "Review the changes above, then save."}
          </small>
        </div>
        <button
          className="primary"
          disabled={!loaded || !changed || editingBlocked}
        >
          {busy ? "Working…" : "Replace grants"}
        </button>
      </div>
    </form>
  );
}
