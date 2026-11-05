import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { Canary, Host, Job } from "./types";
import { RouteLink, useUnsavedChanges } from "./navigation";
import { ErrorNotice, StatusNotice, Time } from "./ui";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const split = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** Polls update clean forms. A changed server value never replaces a draft. */
function useDraft<T>(value: T, label: string, onSaved: () => void) {
  const [baseline, setBaseline] = useState(value),
    [draft, setDraft] = useState(value),
    [incoming, setIncoming] = useState<T | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    pending = useRef(false);
  const dirty = !same(draft, baseline);
  const current = useRef({ baseline, dirty });
  current.current = { baseline, dirty };
  const signature = JSON.stringify(value);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (same(value, current.current.baseline)) {
      setIncoming(null);
      return;
    }
    if (current.current.dirty || pending.current) setIncoming(value);
    else {
      setBaseline(value);
      setDraft(value);
      setIncoming(null);
    }
  }, [signature]);
  useUnsavedChanges(
    dirty || busy,
    busy ? `${label} save in progress (it can complete after leaving)` : label,
  );
  async function save(
    submitted: T,
    request: () => Promise<unknown>,
    message: string,
  ) {
    if (pending.current || !dirty || incoming) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await request();
      if (!alive.current) return;
      setBaseline(submitted);
      setDraft(submitted);
      setIncoming(null);
      setNotice(message);
      onSaved();
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function reset() {
    setBaseline(value);
    setDraft(value);
    setIncoming(null);
    setError(null);
    setNotice("");
  }
  return {
    draft,
    setDraft,
    incoming,
    busy,
    dirty,
    error,
    setError,
    notice,
    save,
    reset,
    keepDraft: () => {
      if (incoming) {
        setBaseline(incoming);
        setIncoming(null);
        setNotice("");
      }
    },
  };
}

function Feedback({
  error,
  dismiss,
  notice,
  changed,
  latest,
  keep,
  reset,
  onVerify,
  busy,
}: {
  error: unknown;
  dismiss: () => void;
  notice: string;
  changed: boolean;
  latest?: ReactNode;
  keep: () => void;
  reset: () => void;
  onVerify: () => void;
  busy: boolean;
}) {
  return (
    <div className="host-form-feedback">
      <ErrorNotice error={error} onDismiss={dismiss} onVerify={onVerify} />
      <StatusNotice>{notice}</StatusNotice>
      {changed && (
        <div className="notice retained" role="status">
          <p>
            Saved values changed while you were editing. Your draft is kept.
          </p>
          <details>
            <summary>Show saved values</summary>
            {latest}
          </details>
          <div className="button-row">
            <button type="button" disabled={busy} onClick={keep}>
              Keep my draft
            </button>
            <button type="button" disabled={busy} onClick={reset}>
              Load saved values
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function HostInventoryForm({
  host,
  canEdit,
  onSaved,
  onVerify,
}: {
  host: Host;
  canEdit: boolean;
  onSaved: () => void;
  onVerify: () => void;
}) {
  const value = {
    name: host.name,
    tags: host.tags.join(", "),
    groups: host.groups.join(", "),
  };
  const model = useDraft(value, "host inventory", onSaved);
  return (
    <form
      className="form host-inventory-form"
      aria-label="Host inventory"
      aria-busy={model.busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canEdit) return;
        const submitted = {
          ...model.draft,
          tags: split(model.draft.tags).join(", "),
          groups: split(model.draft.groups).join(", "),
        };
        void model.save(
          submitted,
          () =>
            api(`/api/hosts/${encodeURIComponent(host.id)}`, "PATCH", {
              name: submitted.name,
              tags: split(submitted.tags),
              groups: split(submitted.groups),
            }),
          "Host inventory saved.",
        );
      }}
    >
      <Feedback
        busy={model.busy}
        error={model.error}
        dismiss={() => model.setError(null)}
        notice={model.notice}
        changed={!!model.incoming}
        keep={model.keepDraft}
        reset={model.reset}
        onVerify={onVerify}
        latest={
          model.incoming && (
            <dl className="facts">
              <dt>Name</dt>
              <dd>{model.incoming.name}</dd>
              <dt>Tags</dt>
              <dd>{model.incoming.tags || "None"}</dd>
              <dt>Groups</dt>
              <dd>{model.incoming.groups || "None"}</dd>
            </dl>
          )
        }
      />
      {!canEdit && (
        <p className="muted">
          Editing inventory requires permission to manage this host. Any draft
          is kept.
        </p>
      )}
      <fieldset className="host-edit-fields" disabled={model.busy || !canEdit}>
        <label>
          Display name
          <input
            name="name"
            required
            maxLength={80}
            value={model.draft.name}
            onChange={(e) =>
              model.setDraft({ ...model.draft, name: e.target.value })
            }
          />
        </label>
        <label>
          Tags (comma separated)
          <input
            name="tags"
            value={model.draft.tags}
            onChange={(e) =>
              model.setDraft({ ...model.draft, tags: e.target.value })
            }
          />
        </label>
        <label>
          Groups (changes permission scopes)
          <input
            name="groups"
            value={model.draft.groups}
            onChange={(e) =>
              model.setDraft({ ...model.draft, groups: e.target.value })
            }
          />
        </label>
      </fieldset>
      <div className="button-row">
        <button
          className="primary"
          disabled={model.busy || !canEdit || !model.dirty || !!model.incoming}
        >
          {model.busy ? "Saving inventory…" : "Save inventory"}
        </button>
        <button
          type="button"
          disabled={model.busy || !model.dirty}
          onClick={model.reset}
        >
          Reset
        </button>
        <small role="status">
          {model.dirty ? "Unsaved changes" : "No unsaved changes"}
        </small>
      </div>
    </form>
  );
}

export function MappingForm({
  host,
  canary,
  loaded,
  unavailable,
  onSaved,
  onVerify,
}: {
  host: Host;
  canary: Canary;
  loaded: boolean;
  unavailable: boolean;
  onSaved: () => void;
  onVerify: () => void;
}) {
  const value = canary.mappings
    .filter((m) => m.hostId === host.id)
    .map((m) => `${m.sourceId}/${m.monitorId}`)
    .sort();
  const model = useDraft(value, "host monitor mappings", onSaved);
  const name = (key: string) => {
    const [source, monitor] = key.split("/");
    return (
      canary.sources
        .find((s) => s.id === source)
        ?.monitors.find((m) => m.monitor.id === monitor)?.monitor.name || key
    );
  };
  const unavailableSelections = model.draft.filter((key) => {
    const [source, monitor] = key.split("/");
    return !canary.sources
      .find((s) => s.id === source)
      ?.monitors.some((m) => m.monitor.id === monitor);
  });
  if (!loaded)
    return (
      <p className="muted" role="status">
        {unavailable
          ? "Canary configuration unavailable. Mappings cannot be edited until loaded."
          : "Loading saved monitor mappings…"}
      </p>
    );
  return (
    <form
      className="form host-mapping-form"
      aria-label="Host monitor mappings"
      aria-busy={model.busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (unavailable) return;
        const mappings = model.draft.map((v) => {
          const [sourceId, monitorId] = v.split("/");
          return { sourceId, monitorId };
        });
        void model.save(
          model.draft,
          () =>
            api(`/api/hosts/${encodeURIComponent(host.id)}/mappings`, "PUT", {
              mappings,
            }),
          "Monitor mappings saved.",
        );
      }}
    >
      <Feedback
        busy={model.busy}
        error={model.error}
        dismiss={() => model.setError(null)}
        notice={model.notice}
        changed={!!model.incoming}
        keep={model.keepDraft}
        reset={model.reset}
        onVerify={onVerify}
        latest={
          model.incoming && (
            <ul>
              {model.incoming.length ? (
                model.incoming.map((v) => <li key={v}>{name(v)}</li>)
              ) : (
                <li>No monitors mapped</li>
              )}
            </ul>
          )
        }
      />
      {unavailable && (
        <p className="muted" role="status">
          Canary configuration is unavailable. Your draft is kept; saving is
          disabled until reads resume.
        </p>
      )}
      {!canary.sources.length && (
        <p className="muted">
          Configure a verified Canary node source on the server first.
        </p>
      )}
      <fieldset
        className="host-edit-fields"
        disabled={model.busy || unavailable}
      >
        {unavailableSelections.map((key) => (
          <label className="check" key={key}>
            <input
              type="checkbox"
              checked
              onChange={() =>
                model.setDraft(model.draft.filter((v) => v !== key))
              }
            />
            Unavailable monitor <code>{key}</code>
          </label>
        ))}
        {canary.sources.map((source) => (
          <fieldset key={source.id}>
            <legend>
              {source.id} · {source.node.name}
            </legend>
            {source.monitors.map((monitor) => {
              const key = `${source.id}/${monitor.monitor.id}`;
              return (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    value={key}
                    checked={model.draft.includes(key)}
                    disabled={
                      model.draft.length >= 20 && !model.draft.includes(key)
                    }
                    onChange={(event) =>
                      model.setDraft(
                        event.target.checked
                          ? [...model.draft, key].sort()
                          : model.draft.filter((v) => v !== key),
                      )
                    }
                  />
                  {monitor.monitor.name} <code>{monitor.monitor.id}</code>
                </label>
              );
            })}
          </fieldset>
        ))}
      </fieldset>
      <div className="button-row">
        <button
          className="primary"
          disabled={
            model.busy || unavailable || !model.dirty || !!model.incoming
          }
        >
          {model.busy ? "Saving mappings…" : "Save monitor mappings"}
        </button>
        <button
          type="button"
          disabled={model.busy || !model.dirty}
          onClick={model.reset}
        >
          Reset
        </button>
      </div>
      <small role="status">
        {model.draft.length} of at most 20 mappings.{" "}
        {model.dirty
          ? "Unsaved changes. Saving replaces this host’s complete monitor mapping set."
          : "No unsaved changes. Canary uptime remains independent of agent readings."}
      </small>
    </form>
  );
}

export function ServiceGuidance({ host }: { host: Host }) {
  return (
    <p className="service-guidance" id="service-request-guidance">
      {host.revoked
        ? "Agent revoked. New requests unavailable."
        : !host.verified
          ? "An administrator must verify this identity before jobs can be requested."
          : host.connectivity !== "connected"
            ? `Agent ${host.connectivity.replaceAll("_", " ")}. Requests queue for up to 5 minutes awaiting connection.`
            : "Requests run through this host’s agent. Track completion in Remote jobs."}{" "}
      Restart requests require confirmation and recent password/MFA
      verification. The agent rejects services outside its local restart
      allowlist.
    </p>
  );
}

export function ServiceRequests({
  host,
  service,
  permissions,
  onQueued,
  onVerify,
}: {
  host: Host;
  service: string;
  permissions?: string[];
  onQueued: () => void;
  onVerify: () => void;
}) {
  const [pending, setPending] = useState(""),
    [error, setError] = useState<unknown>(null),
    [receipt, setReceipt] = useState<Job | null>(null);
  const alive = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useUnsavedChanges(
    !!pending,
    "service request in progress (it can complete after leaving)",
  );
  const blocked = host.revoked || !host.verified;
  const can = (action: string) => !!permissions?.includes(action);
  async function request(action: "logs.read" | "service.restart") {
    if (inFlight.current || blocked || !can(action)) return;
    if (
      action === "service.restart" &&
      !window.confirm(
        `Queue a restart of ${service} on ${host.name}? It can wait up to five minutes for the agent. Recent password/MFA verification and the agent’s local allowlist are required.`,
      )
    )
      return;
    inFlight.current = true;
    setPending(action);
    setError(null);
    setReceipt(null);
    try {
      const job = await api<Job>(
        `/api/hosts/${encodeURIComponent(host.id)}/jobs`,
        "POST",
        {
          action,
          args: { service },
          confirm: action === "service.restart" ? host.id : "",
        },
      );
      if (!alive.current) return;
      setReceipt(job);
      onQueued();
    } catch (error) {
      if (alive.current) setError(error);
    } finally {
      inFlight.current = false;
      if (alive.current) setPending("");
    }
  }
  return (
    <div
      className="service-requests"
      role="group"
      aria-label={`Requests for ${service}`}
      aria-busy={!!pending}
      aria-describedby="service-request-guidance"
    >
      <div className="button-row">
        <button
          type="button"
          disabled={!!pending || blocked || !can("logs.read")}
          title={
            !can("logs.read") ? "Service log permission required" : undefined
          }
          onClick={() => void request("logs.read")}
        >
          {pending === "logs.read" ? "Requesting logs…" : "Request logs"}
        </button>
        <button
          type="button"
          disabled={!!pending || blocked || !can("service.restart")}
          title={
            !can("service.restart")
              ? "Service restart permission required"
              : "The agent rejects restarts outside its local service allowlist."
          }
          onClick={() => void request("service.restart")}
        >
          {pending === "service.restart"
            ? "Requesting restart…"
            : "Request restart"}
        </button>
      </div>
      {(!can("logs.read") || !can("service.restart")) && (
        <small className="service-permission-note">
          {!permissions
            ? "Request permissions unavailable."
            : !can("logs.read") && !can("service.restart")
              ? "No service request permissions for this host."
              : !can("logs.read")
                ? "Service logs are not permitted for your account."
                : "Service restarts are not permitted for your account."}
        </small>
      )}
      <p className="service-pending" role="status">
        {pending ? "Submitting request. No execution is confirmed yet." : ""}
      </p>
      <ErrorNotice
        error={error}
        onDismiss={() => setError(null)}
        onVerify={onVerify}
      />
      {!!error && (!(error instanceof ApiError) || error.status >= 500) && (
        <p className="muted">
          A receipt was not confirmed. Check{" "}
          <RouteLink to={{ view: "jobs" }}>Remote jobs</RouteLink> before trying
          again.
        </p>
      )}
      <StatusNotice>
        {receipt ? (
          <>
            <span className="service-receipt-time">
              Request queued <Time value={receipt.createdAt} />
            </span>{" "}
            <RouteLink to={{ view: "jobs", id: receipt.id }}>
              View outcome →
            </RouteLink>
          </>
        ) : (
          ""
        )}
      </StatusNotice>
    </div>
  );
}
