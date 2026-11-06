import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { GitHubPanel } from "./github";
import type { Project, ProjectCapabilities, ProjectEvent, User } from "./types";
import {
  ChangeComparison,
  Empty,
  ErrorNotice,
  StatusNotice,
  Time,
  Tone,
  stamp,
  type ToneName,
} from "./ui";
import { RouteLink, useNavigation, useUnsavedChanges } from "./navigation";

export const moduleInfo: [string, string][] = [
  [
    "dependencies",
    "Repository observations · read-only GitHub checks and alerts",
  ],
  ["documentation", "Documentation · planned"],
  ["content", "Content · planned"],
  ["releases", "Releases · planned"],
  ["operations", "Operations · planned"],
];
const projectID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const projectName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
const forbiddenControl = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const pollMs = 30000;
const permissionLabels: Record<string, string> = {
  "project.read": "View project",
  "project.manage": "Edit project details",
  "github.read": "View repository observations",
  "github.sync": "Refresh repository observations",
};
const eventLabels: Record<string, string> = {
  "project.create": "Project registered",
  "project.update": "Project updated",
  "github.configure": "Repository configured",
  "github.disconnect": "Repository disconnected",
};

/** Mirrors the server's metadata rules so mistakes are caught before sending. */
function metadataProblem(name: string, description: string) {
  if (!projectName.test(name) || name.trim() !== name)
    return "Names are 1–80 characters: letters, digits, space, '.', '_' or '-', starting with a letter or digit and without trailing spaces.";
  if (new TextEncoder().encode(description).length > 2048)
    return "Descriptions are at most 2,048 bytes.";
  if (forbiddenControl.test(description))
    return "Descriptions may contain newlines and tabs but no other control characters.";
  return "";
}

function ModulePicker({
  modules,
  onChange,
  disabled,
  registered = false,
}: {
  modules: string[];
  onChange: (modules: string[]) => void;
  disabled?: boolean;
  registered?: boolean;
}) {
  const choices = (planned: boolean) =>
    moduleInfo
      .filter(([id]) => (id !== "dependencies") === planned)
      .map(([id, label]) => (
        <label className="check" key={id}>
          <input
            type="checkbox"
            value={id}
            checked={modules.includes(id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...modules, id]
                  : modules.filter((m) => m !== id),
              )
            }
          />
          {label}
        </label>
      ));
  return (
    <fieldset disabled={disabled}>
      <legend>Project features</legend>
      {choices(false)}
      <small>
        {registered
          ? "Use Repository settings to manage the connection and read-only collection."
          : "After registration, use Repository settings to connect GitHub."}
      </small>
      <details className="planned-features">
        <summary>Planned features</summary>
        <p className="muted">
          These connectors are not implemented. Selections record future intent
          only.
        </p>
        {choices(true)}
      </details>
    </fieldset>
  );
}

export function Projects({
  user,
  onVerify,
}: {
  user: User;
  onVerify: () => void;
}) {
  const { route, navigate } = useNavigation();
  const selected = route.id || "";
  // Each project detail mount owns its data; a late response for one project
  // cannot populate another project's view.
  if (selected)
    return (
      <ProjectDetail
        key={selected}
        id={selected}
        user={user}
        onVerify={onVerify}
      />
    );
  return (
    <Inventory
      user={user}
      onVerify={onVerify}
      onOpen={(id) => {
        navigate({ view: "projects", id });
      }}
    />
  );
}

function Inventory({
  user,
  onVerify,
  onOpen,
}: {
  user: User;
  onVerify: () => void;
  onOpen: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null),
    [loadError, setLoadError] = useState<unknown>(null),
    [registering, setRegistering] = useState(false),
    [showArchived, setShowArchived] = useState(false),
    [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const v = await api<{ projects: Project[] | null }>("/api/projects");
        if (alive) {
          setProjects(v.projects || []);
          setLoadError(null);
        }
      } catch (e) {
        if (alive) {
          setLoadError(e);
          if (e instanceof ApiError && [401, 403, 404].includes(e.status))
            setProjects(null);
        }
      }
      if (alive) timer = setTimeout(poll, pollMs);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const admin = user.role === "admin";
  const visible = (projects || []).filter(
    (p) =>
      (showArchived || !p.archived) &&
      `${p.name} ${p.description} ${p.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">MAINTENANCE WORKSPACE</p>
          <h1>Projects</h1>
          <p className="muted">
            Organize project details, access and read-only GitHub observations.
          </p>
        </div>
        {admin && !registering && (
          <button className="primary" onClick={() => setRegistering(true)}>
            + Register a project
          </button>
        )}
      </div>
      {loadError ? (
        <div className="notice error" role="alert">
          <span>
            Projects could not be loaded: {(loadError as Error).message}
            {projects ? " · showing the last loaded inventory" : ""}
          </span>
        </div>
      ) : null}
      {admin && registering && (
        <Register
          onVerify={onVerify}
          onCancel={() => setRegistering(false)}
          onCreated={(p) => onOpen(p.id)}
          full={(projects?.length || 0) >= 100}
        />
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>
            Inventory{" "}
            <span className="count">{projects ? visible.length : "…"}</span>
          </h2>
          <label className="check inline">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
            {projects?.some((p) => p.archived)
              ? ` (${projects.filter((p) => p.archived).length})`
              : ""}
          </label>
        </div>
        {!!projects?.length && (
          <form
            className="project-search"
            role="search"
            aria-label="Filter projects"
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              Search projects
              <input
                type="search"
                name="projectSearch"
                value={query}
                placeholder="Name, description or ID…"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <span className="muted" role="status">
              {visible.length} of {projects.length} · within 100 projects
            </span>
            {query && (
              <button type="button" onClick={() => setQuery("")}>
                Clear search
              </button>
            )}
          </form>
        )}
        {!projects ? (
          <Empty>
            {loadError ? "Inventory unavailable." : "Loading projects…"}
          </Empty>
        ) : !projects.length ? (
          <Empty>
            <h3>No projects yet</h3>
            <p>
              {admin
                ? "Register a project to organize its details and access, then connect GitHub for read-only repository observations. Host enrollment and Canary uptime are managed separately. Nothing is preconfigured."
                : "No projects are shared with your account. An administrator can grant project access."}
            </p>
            {admin && !registering && (
              <button onClick={() => setRegistering(true)}>
                Register a project
              </button>
            )}
          </Empty>
        ) : !visible.length ? (
          <Empty>
            {query
              ? "No matching projects in this inventory."
              : "All projects in view are archived."}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table
              role="table"
              aria-colcount={4}
              className="project-table responsive-table"
            >
              <caption className="sr-only">
                Registered projects and selected features
              </caption>
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader" aria-colindex={1} scope="col">
                    Project
                  </th>
                  <th role="columnheader" aria-colindex={2} scope="col">
                    Status
                  </th>
                  <th role="columnheader" aria-colindex={3} scope="col">
                    Features
                  </th>
                  <th role="columnheader" aria-colindex={4} scope="col">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {visible.map((p) => (
                  <tr role="row" key={p.id}>
                    <td role="cell" aria-colindex={1} data-label="Project">
                      <RouteLink
                        to={{ view: "projects", id: p.id }}
                        className="text-link"
                      >
                        {p.name}
                      </RouteLink>
                      <small>{p.description || p.id}</small>
                    </td>
                    <td role="cell" aria-colindex={2} data-label="Status">
                      <Tone
                        value={p.archived ? "archived" : "active"}
                        tone="neutral"
                      />
                    </td>
                    <td role="cell" aria-colindex={3} data-label="Features">
                      {p.modules.length ? (
                        p.modules.map((m) => (
                          <span className="tag" key={m}>
                            {m === "dependencies"
                              ? "Repository observations"
                              : m + " · planned"}
                          </span>
                        ))
                      ) : (
                        <span className="muted">None selected</span>
                      )}
                    </td>
                    <td role="cell" aria-colindex={4} data-label="Updated">
                      <Time value={p.updatedAt} />
                      <small>Revision {p.revision}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="footnote">
        Capacity is 100 projects including archives. Project IDs are permanent
        and cannot be deleted or reused.
      </p>
    </>
  );
}

function Register({
  onVerify,
  onCancel,
  onCreated,
  full,
}: {
  onVerify: () => void;
  onCancel: () => void;
  onCreated: (p: Project) => void;
  full: boolean;
}) {
  const [id, setId] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [modules, setModules] = useState<string[]>([]),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    pending = useRef(false);
  const markSaved = useUnsavedChanges(
    !!(id || name || description || modules.length),
    busy
      ? "new project registration in progress (it can finish after leaving)"
      : "new project",
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending.current) return;
    if (!projectID.test(id))
      return setError(
        new Error(
          "IDs use 1–64 lowercase letters, digits or '-', starting with a letter or digit.",
        ),
      );
    const problem = metadataProblem(name, description);
    if (problem) return setError(new Error(problem));
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const p = await api<Project>("/api/projects", "POST", {
        id,
        name,
        description,
        modules,
      });
      if (alive.current) {
        markSaved();
        onCreated(p);
      }
    } catch (err) {
      if (alive.current) setError(err);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Register a project</h2>
        <span className="muted">Administrator · recent verification</span>
      </div>
      <div className="panel-body">
        <ErrorNotice
          error={error}
          onDismiss={() => setError(null)}
          onVerify={onVerify}
        />
        {full && (
          <p className="notice">
            The inventory already holds 100 projects, including archives.
            Registration will be refused.
          </p>
        )}
        <form
          className="form"
          onSubmit={submit}
          aria-label="Register a project"
          aria-busy={busy}
        >
          <label>
            Project ID (permanent)
            <input
              name="projectId"
              disabled={busy}
              value={id}
              onChange={(e) => setId(e.target.value)}
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
            />
            <small>
              Lowercase letters, digits and '-'. Cannot be changed or reused.
            </small>
          </label>
          <label>
            Name
            <input
              name="projectName"
              disabled={busy}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <label>
            Description
            <textarea
              name="projectDescription"
              disabled={busy}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
            <small>
              Metadata only. Never paste credentials, commands or connection
              URLs.
            </small>
          </label>
          <ModulePicker
            modules={modules}
            onChange={setModules}
            disabled={busy}
          />
          <div className="button-row">
            <button className="primary" disabled={busy}>
              {busy ? "Working…" : "Register project"}
            </button>
            <button type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

type Edit = {
  baseline: Project;
  name: string;
  description: string;
  modules: string[];
};
const fromProject = (p: Project): Edit => ({
  baseline: p,
  name: p.name,
  description: p.description,
  modules: [...p.modules],
});
const sameModules = (a: string[], b: string[]) =>
  a.length === b.length && a.every((m) => b.includes(m));
const isDirty = (e: Edit) =>
  e.name !== e.baseline.name ||
  e.description !== e.baseline.description ||
  !sameModules(e.modules, e.baseline.modules);

function reapplyEdit(edit: Edit, latest: Project): Edit {
  const removed = new Set(
    edit.baseline.modules.filter((module) => !edit.modules.includes(module)),
  );
  const added = edit.modules.filter(
    (module) => !edit.baseline.modules.includes(module),
  );
  return {
    baseline: latest,
    name: edit.name !== edit.baseline.name ? edit.name : latest.name,
    description:
      edit.description !== edit.baseline.description
        ? edit.description
        : latest.description,
    modules: [
      ...new Set([
        ...latest.modules.filter((module) => !removed.has(module)),
        ...added,
      ]),
    ],
  };
}
const featureNames = (modules: string[]) =>
  modules
    .map((module) => moduleInfo.find(([key]) => key === module)?.[1] || module)
    .join(", ") || "None";

function capabilityTone(state: string, current: boolean): ToneName {
  if (!current) return "neutral";
  if (state === "fresh") return "good";
  if (["stale", "partial", "pending", "rate_limited"].includes(state))
    return "warn";
  if (
    ["disabled", "unsupported", "not_configured", "module_disabled"].includes(
      state,
    )
  )
    return "neutral";
  return "bad";
}

function ProjectDetail({
  id,
  user,
  onVerify,
}: {
  id: string;
  user: User;
  onVerify: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null),
    [caps, setCaps] = useState<ProjectCapabilities | null>(null),
    [events, setEvents] = useState<ProjectEvent[] | null>(null),
    [historyError, setHistoryError] = useState<unknown>(null),
    [gone, setGone] = useState(false),
    [loadError, setLoadError] = useState<unknown>(null),
    [edit, setEdit] = useState<Edit | null>(null),
    [conflict, setConflict] = useState<Project | null>(null),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    seq = useRef(0),
    editRef = useRef<Edit | null>(null),
    settingsRef = useRef<HTMLDetailsElement>(null);
  editRef.current = edit;
  useUnsavedChanges(!!edit && isDirty(edit), "project details");
  useEffect(() => {
    if (!conflict || !settingsRef.current) return;
    settingsRef.current.open = true;
    const frame = requestAnimationFrame(() =>
      settingsRef.current
        ?.querySelector(".project-conflict-review")
        ?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [conflict?.revision]);
  useEffect(() => {
    if (!error && !notice) return;
    if (settingsRef.current) settingsRef.current.open = true;
    const frame = requestAnimationFrame(() =>
      settingsRef.current
        ?.querySelector(".project-edit-feedback")
        ?.scrollIntoView({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [error, notice]);
  const path = `/api/projects/${encodeURIComponent(id)}`;

  function adopt(p: Project) {
    setProject(p);
    const prev = editRef.current;
    if (!prev || (prev.baseline.revision !== p.revision && !isDirty(prev))) {
      setEdit(fromProject(p));
      setConflict(null);
    } else if (prev.baseline.revision !== p.revision) {
      // Someone else saved while unsaved edits exist: surface, never overwrite.
      setConflict(p);
    }
  }

  async function load() {
    const n = ++seq.current;
    try {
      const [p, c] = await Promise.all([
        api<Project>(path),
        api<ProjectCapabilities>(`${path}/capabilities`),
      ]);
      if (!alive.current || n !== seq.current) return;
      adopt(p);
      setGone(false);
      setCaps(c);
      setLoadError(null);
      // History is secondary evidence. Its failure must not hide successful
      // project/capability reads or the independently collected repository.
      void api<{ events: ProjectEvent[] | null }>(`${path}/audit`)
        .then((value) => {
          if (!alive.current || n !== seq.current) return;
          setEvents(value.events || []);
          setHistoryError(null);
        })
        .catch((error) => {
          if (!alive.current || n !== seq.current) return;
          setHistoryError(error);
          if (
            error instanceof ApiError &&
            [401, 403, 404].includes(error.status)
          )
            setEvents(null);
        });
    } catch (e) {
      if (!alive.current || n !== seq.current) return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        // Absent and no-longer-readable are identical; drop everything retained.
        setGone(true);
        setProject(null);
        setCaps(null);
        setEvents(null);
        setEdit(null);
        setConflict(null);
      }
      setLoadError(e);
    }
  }
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await load();
      if (alive.current) timer = setTimeout(poll, pollMs);
    }
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
  }, []);

  const permissions = caps?.permissions || [];
  const canManage = permissions.includes("project.manage");
  const capsCurrent = !!caps && !loadError;

  async function put(
    body: Omit<Project, "id" | "createdAt" | "updatedAt">,
  ): Promise<Project> {
    return api<Project>(path, "PUT", {
      name: body.name,
      description: body.description,
      modules: body.modules,
      archived: body.archived,
      revision: body.revision,
    });
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!edit || conflict || busy) return;
    const problem = metadataProblem(edit.name, edit.description);
    if (problem) return setError(new Error(problem));
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const p = await put({
        name: edit.name,
        description: edit.description,
        modules: edit.modules,
        archived: edit.baseline.archived,
        revision: edit.baseline.revision,
      });
      if (!alive.current) return;
      setProject(p);
      setEdit(fromProject(p));
      setNotice(`Saved as revision ${p.revision}.`);
      void load();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 409) {
        try {
          const latest = await api<Project>(path);
          if (!alive.current) return;
          setProject(latest);
          setConflict(latest);
          setError(null);
        } catch (reload) {
          if (alive.current) setError(reload);
        }
      } else setError(err);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function setArchived(archived: boolean) {
    if (!project || busy) return;
    if (
      !window.confirm(
        archived
          ? `Archive ${project.name}? It stays readable to authorized accounts; all features become disabled and GitHub collection stops until restored.`
          : `Restore ${project.name}? Selected features become available again.`,
      )
    )
      return;
    const before = project;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const p = await put({ ...before, archived });
      if (!alive.current) return;
      setProject(p);
      // Only `archived` changed, so unsaved edits based on the prior revision
      // stay valid against the new one.
      setEdit((prev) =>
        prev && prev.baseline.revision === before.revision
          ? { ...prev, baseline: p }
          : prev,
      );
      setNotice(archived ? "Project archived." : "Project restored.");
      void load();
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.status === 409) {
        setError(
          new Error(
            "This project changed before the archive state was saved. It has been reloaded; review it and try again.",
          ),
        );
        void load();
      } else setError(err);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const back = (
    <RouteLink className="text-link" to={{ view: "projects" }}>
      ← All projects
    </RouteLink>
  );
  if (gone)
    return (
      <>
        <div className="page-heading">
          <div>
            {back}
            <h1>Project unavailable</h1>
          </div>
        </div>
        <section className="panel">
          <Empty>
            <h3>Project not found</h3>
            <p>
              It does not exist or your account can no longer read it. Retained
              details were cleared.
            </p>
          </Empty>
        </section>
      </>
    );
  if (!project)
    return (
      <>
        <div className="page-heading">
          <div>
            {back}
            <h1>Project</h1>
          </div>
        </div>
        {loadError ? (
          <div className="notice error" role="alert">
            <span>
              Project could not be loaded: {(loadError as Error).message}
            </span>
          </div>
        ) : (
          <Empty>Loading project…</Empty>
        )}
      </>
    );
  const dirty = !!edit && isDirty(edit);
  const proposed = conflict && edit ? reapplyEdit(edit, conflict) : null;
  return (
    <>
      <div className="page-heading project-page-heading">
        <div>
          <div className="project-breadcrumb">
            {back}
            <button
              className="text-link"
              onClick={() => {
                const settings = settingsRef.current;
                if (settings) {
                  settings.open = true;
                  settings.scrollIntoView({ block: "start" });
                  settings.querySelector("summary")?.focus();
                }
              }}
            >
              Project settings
            </button>
          </div>
          <h1>
            {project.name}{" "}
            {project.archived && <Tone value="archived" tone="neutral" />}
          </h1>
          <p className="muted project-description">
            {project.description || "No description."}
          </p>
        </div>
      </div>
      <div aria-live="polite">
        {loadError && !error ? (
          <div className="notice error" role="alert">
            <span>
              Refresh failed: {(loadError as Error).message}. Showing the last
              loaded details; feature states below are not current.
            </span>
          </div>
        ) : null}
      </div>
      <GitHubPanel
        key={project.id}
        project={project}
        permissions={caps ? permissions : null}
        admin={user.role === "admin"}
        onVerify={onVerify}
        onChanged={() => void load()}
      />
      <details ref={settingsRef} className="disclosure project-settings">
        <summary>
          <strong>Project settings</strong>
          <span>
            {canManage
              ? "Details, access, history and archive"
              : "Details, access and history"}
          </span>
        </summary>
        <div className="disclosure-body">
          <p className="project-meta">
            <code>{project.id}</code>
            <span>
              Updated <Time value={project.updatedAt} />
            </span>
            <span>Revision {project.revision}</span>
          </p>
          {conflict && proposed && edit && canManage && (
            <div
              className="notice conflict project-conflict-review"
              role="alert"
            >
              <b>Revision {conflict.revision} was saved by someone else.</b>
              <p>
                Your earlier draft is based on revision {edit.baseline.revision}
                . Compare changes to the latest saved values below. Untouched
                fields stay current. Reapply to update the form, then review and
                save separately.
              </p>
              <ChangeComparison
                label="Project changes for review"
                savedHeading={`Saved (revision ${conflict.revision})`}
                rows={[
                  {
                    key: "name",
                    label: "Name",
                    saved: conflict.name,
                    proposed: proposed.name,
                    changed: conflict.name !== proposed.name,
                  },
                  {
                    key: "description",
                    label: "Description",
                    saved: conflict.description || "None",
                    proposed: proposed.description || "None",
                    changed: conflict.description !== proposed.description,
                  },
                  {
                    key: "modules",
                    label: "Features",
                    saved: featureNames(conflict.modules),
                    proposed: featureNames(proposed.modules),
                    changed: !sameModules(conflict.modules, proposed.modules),
                  },
                  {
                    key: "archived",
                    label: "Archived",
                    saved: conflict.archived ? "Yes" : "No",
                    proposed: proposed.baseline.archived ? "Yes" : "No",
                  },
                ]}
              />
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => {
                    setEdit(proposed);
                    setConflict(null);
                    setError(null);
                  }}
                >
                  Reapply my changes for review
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEdit(fromProject(conflict));
                    setConflict(null);
                    setError(null);
                  }}
                >
                  Discard my draft and load latest
                </button>
              </div>
            </div>
          )}
          <div className="two-columns">
            <section className="panel">
              <div className="panel-heading">
                <h2>Project details</h2>
                <span className="muted">
                  {canManage
                    ? `Editing revision ${edit?.baseline.revision ?? project.revision}`
                    : "Read only"}
                </span>
              </div>
              <div className="panel-body">
                <div className="project-edit-feedback">
                  <ErrorNotice
                    error={error}
                    onDismiss={() => setError(null)}
                    onVerify={onVerify}
                  />
                  <StatusNotice>{notice}</StatusNotice>
                </div>
                {!canManage || !edit ? (
                  <dl className="facts">
                    <dt>Name</dt>
                    <dd>{project.name}</dd>
                    <dt>Description</dt>
                    <dd className="project-description">
                      {project.description || "None"}
                    </dd>
                    <dt>Features</dt>
                    <dd>
                      {project.modules.length
                        ? featureNames(project.modules)
                        : "None selected"}
                    </dd>
                    {caps && (
                      <>
                        <dt>Access</dt>
                        <dd>
                          Your account can read this project but not manage it.
                        </dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <form
                    className="form"
                    onSubmit={save}
                    aria-label="Project details"
                  >
                    {conflict && (
                      <p className="draft-label">
                        <b>Your earlier draft · not yet reconciled.</b> Choose a
                        recovery action above to update these fields.
                      </p>
                    )}
                    <label>
                      Name
                      <input
                        name="editName"
                        disabled={busy}
                        value={edit.name}
                        onChange={(e) =>
                          setEdit({ ...edit, name: e.target.value })
                        }
                        required
                        maxLength={80}
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Description
                      <textarea
                        name="editDescription"
                        disabled={busy}
                        value={edit.description}
                        rows={4}
                        onChange={(e) =>
                          setEdit({ ...edit, description: e.target.value })
                        }
                      />
                    </label>
                    <ModulePicker
                      registered
                      disabled={busy}
                      modules={edit.modules}
                      onChange={(modules) => setEdit({ ...edit, modules })}
                    />
                    <div className="button-row">
                      <button
                        className="primary"
                        disabled={busy || !dirty || !!conflict}
                      >
                        {busy ? "Working…" : "Save project details"}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !dirty}
                        onClick={() => {
                          setEdit(fromProject(conflict || project));
                          setConflict(null);
                        }}
                      >
                        Reset
                      </button>
                    </div>
                    <small>
                      Saving requires recent password and MFA verification. A
                      stale revision is rejected rather than overwriting another
                      save.
                    </small>
                  </form>
                )}
                {canManage && (
                  <div className="project-lifecycle">
                    <h3>Project lifecycle</h3>
                    <p className="muted">
                      Archiving keeps this project and its history, and pauses
                      repository collection.
                    </p>
                    <div className="button-row">
                      {project.archived ? (
                        <button
                          onClick={() => void setArchived(false)}
                          disabled={busy}
                        >
                          Restore project
                        </button>
                      ) : (
                        <button
                          className="danger"
                          onClick={() => void setArchived(true)}
                          disabled={busy}
                        >
                          Archive project
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h2>Features & access</h2>
                {!caps && <span className="muted">Unavailable</span>}
              </div>
              {!caps ? (
                <Empty>Capabilities unavailable.</Empty>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Feature</th>
                        <th>Availability</th>
                      </tr>
                    </thead>
                    <tbody>
                      {caps.modules
                        .filter((m) => m.enabled || m.id === "dependencies")
                        .map((m) => (
                          <tr key={m.id}>
                            <td>
                              {m.id === "dependencies"
                                ? "Repository observations"
                                : m.id}
                              <small>
                                {m.enabled ? "Selected" : "Not selected"}
                              </small>
                            </td>
                            <td>
                              <Tone
                                value={m.state}
                                tone={capabilityTone(m.state, capsCurrent)}
                              />
                              <small>
                                {m.reason === "github_read_only"
                                  ? "Read-only GitHub collection"
                                  : m.reason.replaceAll("_", " ")}
                                {!capsCurrent && " · last known, not current"}
                              </small>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="panel-body">
                <p className="muted">
                  Effective permissions:{" "}
                  {caps
                    ? permissions.map((p) => (
                        <span className="tag" key={p}>
                          {permissionLabels[p] || p.replaceAll(".", " ")}
                        </span>
                      ))
                    : "unknown"}
                </p>
                <p className="muted">
                  No feature can publish, deploy or write to an application or
                  repository. Planned features are not implemented.
                </p>
                {!!caps && (
                  <details className="permission-reference">
                    <summary>Permission identifiers</summary>
                    <dl>
                      {permissions.map((p) => (
                        <div key={p}>
                          <dt>{permissionLabels[p] || p}</dt>
                          <dd>
                            <code>{p}</code>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </div>
            </section>
          </div>
          <section className="panel project-history">
            <div className="panel-heading">
              <h2>Project history</h2>
              <span className="muted">
                Newest 100 events · no prior field values
              </span>
            </div>
            {!!historyError && (
              <p className="notice error" role="alert">
                History could not be refreshed:{" "}
                {(historyError as Error).message}.{" "}
                {events
                  ? "Showing last-loaded events."
                  : "No current history can be established."}
              </p>
            )}
            {!events ? (
              historyError ? null : (
                <p className="project-history-loading" role="status">
                  Loading project history…
                </p>
              )
            ) : !events.length ? (
              <Empty>No project events recorded.</Empty>
            ) : (
              <ol className="timeline">
                {events.map((a, i) => (
                  <li key={`${a.at}-${a.action}-${i}`}>
                    <span className="timeline-dot" />
                    <div>
                      <strong title={a.action}>
                        {eventLabels[a.action] || a.action}
                      </strong>{" "}
                      <span className="tag">revision {a.revision}</span>
                      <small>
                        <Time value={a.at} />
                      </small>
                      <details className="project-actor">
                        <summary>
                          Actor:{" "}
                          {a.actor.length > 18
                            ? a.actor.slice(0, 12) + "…"
                            : a.actor || "Not recorded"}
                        </summary>
                        <code>{a.actor || "Not recorded"}</code>
                      </details>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </details>
    </>
  );
}
