import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Job } from "./types";
import { RouteLink } from "./navigation";
import { Dialog, ErrorNotice, StatusNotice, Time, Tone, stamp } from "./ui";

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
            {job.action} <Tone value={job.state} />
          </>
        ) : (
          "Job outcome"
        )
      }
    >
      <p>
        Job <code className="wrap">{id}</code>
      </p>
      <div className="job-status-tools">
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "Refreshing status…" : "Refresh status"}
        </button>
        <span className="muted">
          {checkedAt ? (
            <>
              Checked <Time value={checkedAt} />
            </>
          ) : (
            "No current status loaded"
          )}{" "}
          · updates every 5 seconds while open
        </span>
      </div>
      <ErrorNotice error={error} onDismiss={() => setError(null)} />
      <StatusNotice>
        {job ? `Request status: ${job.state.replaceAll("_", " ")}.` : ""}
      </StatusNotice>
      {job ? (
        <>
          <p>
            <RouteLink to={{ view: "host", id: job.hostId }}>
              View host →
            </RouteLink>
          </p>
          <p>
            Created {stamp(job.createdAt)} · dispatched{" "}
            {stamp(job.dispatchedAt)} · finished {stamp(job.finishedAt)}
          </p>
          {job.action === "host.reboot" && (
            <p>
              New boot observed:{" "}
              <b>{job.rebootObserved ? "Yes" : "Not observed"}</b>
            </p>
          )}
          {job.result ? (
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
            <p>
              Output is pending or your account does not have output permission.
            </p>
          )}
          <p className="muted">
            Command output may contain secrets. It is accessible only with an
            explicit output grant.
          </p>
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
