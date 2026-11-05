import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Job } from "./types";
import { RouteLink } from "./navigation";
import { Dialog, ErrorNotice, StatusNotice, Time, Tone, stamp } from "./ui";

export function jobAction(action: string) {
  return (
    (
      {
        "logs.read": "Service logs",
        "service.restart": "Service restart",
        diagnostic: "Diagnostic",
        "host.reboot": "Host reboot",
      } as Record<string, string>
    )[action] || action.replaceAll(".", " ")
  );
}

function outputMessage(job: Job) {
  if (job.canReadOutput === false)
    return "Your account does not have permission to view this host’s command output. Ask an administrator for a job-output grant if needed.";
  if (job.canReadOutput !== true)
    return "Output access could not be established. Refresh status to check again.";
  if (job.state === "queued")
    return "Not dispatched yet. Output can appear after the agent receives this request and returns a result.";
  if (job.state === "dispatched")
    return "Awaiting an agent result. Dispatch does not confirm completion.";
  if (job.state === "uncertain")
    return "No result was received. Execution is uncertain; this request will not be repeated automatically.";
  return "No command output was recorded for this request.";
}

/** Read-only, URL-addressable outcome. Every read applies current output grants. */
export function JobOutcome({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const [job, setJob] = useState<Job | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(true),
    [checkedAt, setCheckedAt] = useState(0);
  const alive = useRef(false),
    version = useRef(0),
    pending = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    clearTimeout(timer.current);
    const request = ++version.current;
    setBusy(true);
    try {
      const value = await api<Job>(`/api/jobs/${encodeURIComponent(id)}`);
      if (!alive.current || request !== version.current) return;
      setJob(value);
      setCheckedAt(Date.now());
      setError(null);
    } catch (error) {
      if (!alive.current || request !== version.current) return;
      // Do not retain output after a failed authorization or unavailable read.
      setJob(null);
      setCheckedAt(0);
      setError(error);
    } finally {
      if (alive.current && request === version.current) {
        pending.current = false;
        setBusy(false);
        timer.current = setTimeout(() => void refresh(), 5000);
      }
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      pending.current = false;
      version.current++;
      clearTimeout(timer.current);
    };
  }, [id]);
  return (
    <Dialog
      wide
      onClose={onClose}
      title={
        job ? (
          <>
            {jobAction(job.action)} <Tone value={job.state} />
          </>
        ) : (
          "Job outcome"
        )
      }
    >
      {job && (
        <div className="job-target">
          <p>
            <strong>
              {job.args.service || job.args.diagnostic || "Host request"}
            </strong>{" "}
            on{" "}
            <RouteLink to={{ view: "host", id: job.hostId }}>
              {job.hostName || job.hostId}
            </RouteLink>
          </p>
        </div>
      )}
      <details className="job-identifiers">
        <summary>Job identity</summary>
        <dl className="job-identity-fields">
          <div>
            <dt>Job ID</dt>
            <dd>
              <code className="wrap">{id}</code>
            </dd>
          </div>
          {job && (
            <>
              <div>
                <dt>Host ID</dt>
                <dd>
                  <code className="wrap">{job.hostId}</code>
                </dd>
              </div>
              <div>
                <dt>Action key</dt>
                <dd>
                  <code>{job.action}</code>
                </dd>
              </div>
            </>
          )}
        </dl>
      </details>
      <div className="job-status-tools">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "Refreshing status…" : "Refresh status"}
        </button>
        <span className="job-checked muted">
          {checkedAt ? (
            <>
              Checked <Time value={checkedAt} />
            </>
          ) : (
            "No current status loaded"
          )}
        </span>
        <small className="job-auto-refresh">
          Checks every 5 seconds while open.
        </small>
      </div>
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
      <div className="sr-only">
        <StatusNotice>
          {job ? `Request status: ${job.state.replaceAll("_", " ")}.` : ""}
        </StatusNotice>
      </div>
      {job ? (
        <>
          <dl className="job-lifecycle">
            <div>
              <dt>Created</dt>
              <dd>{stamp(job.createdAt)}</dd>
            </div>
            <div>
              <dt>Dispatched</dt>
              <dd>
                {job.dispatchedAt
                  ? stamp(job.dispatchedAt)
                  : job.state === "queued"
                    ? "Not dispatched yet"
                    : "Not recorded"}
              </dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>
                {job.finishedAt
                  ? stamp(job.finishedAt)
                  : ["queued", "dispatched"].includes(job.state)
                    ? "Awaiting result"
                    : "Not recorded"}
              </dd>
            </div>
          </dl>
          {job.action === "host.reboot" && (
            <p>
              New boot observed:{" "}
              <b>{job.rebootObserved ? "Yes" : "Not observed"}</b>
            </p>
          )}
          {job.canReadOutput === true && job.result ? (
            <>
              <p>
                Exit status {job.result.exitCode}{" "}
                {job.result.truncated && "· output truncated"}
              </p>
              <h3>stdout</h3>
              <pre>{job.result.stdout || "(empty)"}</pre>
              <h3>stderr</h3>
              <pre>{job.result.stderr || "(empty)"}</pre>
            </>
          ) : (
            <p className="job-output-state">{outputMessage(job)}</p>
          )}
          {job.canReadOutput === true && job.result && (
            <p className="muted">
              Command output may contain secrets. It is accessible only with an
              explicit output grant.
            </p>
          )}
        </>
      ) : (
        <p>
          {busy
            ? "Loading job status…"
            : "Job information is unavailable. Refresh status to try again."}
        </p>
      )}
    </Dialog>
  );
}
