import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { GitHubPanel } from "./github";
import type { Project, ProjectCapabilities, ProjectEvent, User } from "./types";
import { Empty, ErrorNotice, Time, Tone, stamp, type ToneName } from "./ui";
import { RouteLink, useNavigation, useUnsavedChanges } from "./navigation";

export const moduleInfo: [string, string][] = [
  ["dependencies", "Repository health · read-only GitHub checks and alerts"],
  ["documentation", "Documentation · planned"],
  ["content", "Content · planned"],
  ["releases", "Releases · planned"],
  ["operations", "Operations · planned"],
];
const projectID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const projectName = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/;
const forbiddenControl = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const pollMs = 30000;
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
}: {
  modules: string[];
  onChange: (modules: string[]) => void;
  disabled?: boolean;
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
        Connect a repository after saving to start read-only collection.
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
    [showArchived, setShowArchived] = useState(false);
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
        if (alive) setLoadError(e);
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
  const visible = (projects || []).filter((p) => showArchived || !p.archived);
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
          <Empty>All projects in view are archived.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="project-table responsive-table">
              <caption className="sr-only">
                Registered projects and selected features
              </caption>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Features</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Project">
                      <RouteLink
                        to={{ view: "projects", id: p.id }}
                        className="text-link"
                      >
                        {p.name}
                      </RouteLink>
                      <small>{p.description || p.id}</small>
                    </td>
                    <td data-label="Status">
                      <Tone
                        value={p.archived ? "archived" : "active"}
                        tone="neutral"
                      />
                    </td>
                    <td data-label="Features">
                      {p.modules.length ? (
                        p.modules.map((m) => (
                          <span className="tag" key={m}>
                            {m === "dependencies"
                              ? "Repository health"
                              : m + " · planned"}
                          </span>
                        ))
                      ) : (
                        <span className="muted">None selected</span>
                      )}
                    </td>
                    <td data-label="Updated">
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
  const alive = useRef(true);
  const markSaved = useUnsavedChanges(
    !!(id || name || description || modules.length),
    "new project",
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!projectID.test(id))
      return setError(
        new Error(
          "IDs use 1–64 lowercase letters, digits or '-', starting with a letter or digit.",
        ),
      );
    const problem = metadataProblem(name, description);
    if (problem) return setError(new Error(problem));
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
        >
          <label>
            Project ID (permanent)
            <input
              name="projectId"
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
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
            <small>
              Metadata only. Never paste credentials, commands or connection
              URLs.
            </small>
          </label>
          <ModulePicker modules={modules} onChange={setModules} />
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
    if (conflict && settingsRef.current) settingsRef.current.open = true;
  }, [conflict]);
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
      const [p, c, a] = await Promise.all([
        api<Project>(path),
        api<ProjectCapabilities>(`${path}/capabilities`),
        api<{ events: ProjectEvent[] | null }>(`${path}/audit`),
      ]);
      if (!alive.current || n !== seq.current) return;
      adopt(p);
      setCaps(c);
      setEvents(a.events || []);
      setLoadError(null);
    } catch (e) {
      if (!alive.current || n !== seq.current) return;
      if (e instanceof ApiError && e.status === 404) {
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
          setError(
            new Error(
              `This project changed to revision ${latest.revision} after you loaded it. Your edits were not saved and are kept below.`,
            ),
          );
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
          ? `Archive ${project.name}? It stays readable to authorized accounts; all modules become disabled and GitHub collection stops until restored.`
          : `Restore ${project.name}? Selected modules become available again.`,
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
  const differs = conflict &&
    edit && {
      name: conflict.name !== edit.name,
      description: conflict.description !== edit.description,
      modules: !sameModules(conflict.modules, edit.modules),
      archived: conflict.archived !== edit.baseline.archived,
    };
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
        <ErrorNotice
          error={error}
          onDismiss={() => setError(null)}
          onVerify={onVerify}
        />
        {loadError && !error ? (
          <div className="notice error" role="alert">
            <span>
              Refresh failed: {(loadError as Error).message}. Showing the last
              loaded details; module states below are not current.
            </span>
          </div>
        ) : null}
        {notice && <div className="notice">{notice}</div>}
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
                {!canManage || !edit ? (
                  <dl className="facts">
                    <dt>Name</dt>
                    <dd>{project.name}</dd>
                    <dt>Description</dt>
                    <dd className="project-description">
                      {project.description || "None"}
                    </dd>
                    <dt>Modules</dt>
                    <dd>{project.modules.join(", ") || "None selected"}</dd>
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
                    {conflict && differs && (
                      <div className="notice conflict" role="alert">
                        <b>
                          Revision {conflict.revision} was saved by someone
                          else.
                        </b>
                        <p>
                          Your unsaved edits are based on revision{" "}
                          {edit.baseline.revision}. Compare and choose how to
                          continue; nothing is overwritten automatically.
                        </p>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Field</th>
                                <th>Saved (revision {conflict.revision})</th>
                                <th>Your edits</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr className={differs.name ? "changed" : ""}>
                                <td>Name</td>
                                <td>{conflict.name}</td>
                                <td>{edit.name}</td>
                              </tr>
                              <tr
                                className={differs.description ? "changed" : ""}
                              >
                                <td>Description</td>
                                <td className="project-description">
                                  {conflict.description || "None"}
                                </td>
                                <td className="project-description">
                                  {edit.description || "None"}
                                </td>
                              </tr>
                              <tr className={differs.modules ? "changed" : ""}>
                                <td>Modules</td>
                                <td>{conflict.modules.join(", ") || "None"}</td>
                                <td>{edit.modules.join(", ") || "None"}</td>
                              </tr>
                              <tr className={differs.archived ? "changed" : ""}>
                                <td>Archived</td>
                                <td>{conflict.archived ? "Yes" : "No"}</td>
                                <td>{edit.baseline.archived ? "Yes" : "No"}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <div className="button-row">
                          <button
                            type="button"
                            onClick={() => {
                              setEdit({ ...edit, baseline: conflict });
                              setConflict(null);
                              setError(null);
                            }}
                          >
                            Keep my edits on revision {conflict.revision}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEdit(fromProject(conflict));
                              setConflict(null);
                              setError(null);
                            }}
                          >
                            Discard my edits
                          </button>
                        </div>
                      </div>
                    )}
                    <label>
                      Name
                      <input
                        name="editName"
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
                        value={edit.description}
                        rows={4}
                        onChange={(e) =>
                          setEdit({ ...edit, description: e.target.value })
                        }
                      />
                    </label>
                    <ModulePicker
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
                                ? "Repository health"
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
                          {p}
                        </span>
                      ))
                    : "unknown"}
                </p>
                <p className="muted">
                  No module can publish, deploy or write to an application or
                  repository. Unsupported modules are not working features.
                </p>
              </div>
            </section>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Project history</h2>
              <span className="muted">
                Newest 100 events · no prior field values
              </span>
            </div>
            {!events ? (
              <Empty>History unavailable.</Empty>
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
                        {stamp(a.at)} · actor {a.actor.slice(0, 12)}
                      </small>
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
