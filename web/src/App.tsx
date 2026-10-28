import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, csrf } from "./api";
import type { Audit, Canary, Host, Job, Reading, User, Monitor } from "./types";

const stamp = (n: number) => (n ? new Date(n).toLocaleString() : "Never");
const bytes = (n: number) =>
  n >= 2 ** 30
    ? `${(n / 2 ** 30).toFixed(1)} GiB`
    : n >= 2 ** 20
      ? `${(n / 2 ** 20).toFixed(1)} MiB`
      : `${n.toFixed(0)} B`;
const uptime = (n: number) =>
  `${Math.floor(n / 86400)}d ${Math.floor((n % 86400) / 3600)}h`;
const list = (s: string) =>
  s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
function Tone({ value }: { value: string }) {
  return (
    <span
      className={`chip ${["up", "connected", "fresh", "normal", "succeeded", "completed"].includes(value) ? "good" : ["down", "failed", "revoked", "denied"].includes(value) ? "bad" : ["stale", "uncertain", "warning", "timed_out"].includes(value) ? "warn" : "neutral"}`}
    >
      <span aria-hidden="true">●</span> {value.replaceAll("_", " ")}
    </span>
  );
}
function monitorState(m: Monitor) {
  const observations = m.observations || [];
  const fresh = observations.filter(
    (o) =>
      Date.now() - o.checkedAt <= Math.max(90000, 3 * m.monitor.intervalMs) &&
      o.checkedAt <= Date.now() + 30000,
  );
  if (fresh.some((o) => o.state === "down")) return "down";
  if (m.state === "paused") return "paused";
  if (
    m.configConflict ||
    m.unknownNodes > 0 ||
    fresh.length !== observations.length ||
    !fresh.length
  )
    return "unknown";
  return m.state;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}
function Form({
  children,
  onSubmit,
  submit = "Save",
  busy = false,
}: {
  children: ReactNode;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  submit?: string;
  busy?: boolean;
}) {
  return (
    <form onSubmit={onSubmit} className="form">
      {children}
      <button className="primary" disabled={busy}>
        {busy ? "Working…" : submit}
      </button>
    </form>
  );
}
function field(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return new FormData(e.currentTarget);
}

function Auth({ onLogin }: { onLogin: (u: User) => void }) {
  const [setup, setSetup] = useState(false),
    [checking, setChecking] = useState(true),
    [secret, setSecret] = useState(""),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ setupRequired: boolean }>("/api/auth/status")
      .then((v) => setSetup(v.setupRequired))
      .catch((e) => setError(String(e.message)))
      .finally(() => setChecking(false));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    const f = field(e);
    setBusy(true);
    setError("");
    try {
      if (setup && !secret) {
        const token = String(f.get("token"));
        const v = await api<{ secret: string }>(
          "/api/auth/setup/begin",
          "POST",
          { token, name: f.get("name"), password: f.get("password") },
        );
        setToken(token);
        setSecret(v.secret);
      } else {
        const path = setup ? "/api/auth/setup/finish" : "/api/auth/login";
        const v = await api<{ user: User; csrfToken: string }>(
          path,
          "POST",
          setup
            ? { token, code: f.get("code") }
            : {
                name: f.get("name"),
                password: f.get("password"),
                code: f.get("code"),
              },
        );
        csrf(v.csrfToken);
        setSecret("");
        setToken("");
        onLogin(v.user);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth">
      <div className="auth-brand">
        <img src="/phoenix.svg" alt="" width="48" height="48" />
        <b>Phoenix</b>
        <span>Infrastructure, within reach.</span>
      </div>
      <section className="panel auth-card">
        <p className="eyebrow">YOUR INFRASTRUCTURE</p>
        <h1>
          {checking
            ? "Connecting…"
            : setup
              ? "Set up your administrator"
              : "Welcome back"}
        </h1>
        <p className="muted">
          Secure access to your fleet. Password and authenticator verification
          are required.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!checking && (
          <Form
            onSubmit={submit}
            submit={
              setup
                ? secret
                  ? "Verify and finish setup"
                  : "Prepare authenticator"
                : "Sign in"
            }
            busy={busy}
          >
            {setup && !secret && (
              <label>
                Bootstrap token
                <input
                  name="token"
                  type="password"
                  required
                  autoComplete="off"
                />
                <small>
                  Read the private setup.token file on your Phoenix server. It
                  expires after 30 minutes.
                </small>
              </label>
            )}
            {!secret && (
              <>
                <label>
                  Account name
                  <input
                    name="name"
                    autoComplete="username"
                    required
                    maxLength={80}
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete={setup ? "new-password" : "current-password"}
                    required
                    minLength={setup ? 14 : 1}
                    maxLength={72}
                  />
                </label>
              </>
            )}
            {secret && (
              <div className="notice">
                <b>Add Phoenix to your authenticator</b>
                <p>
                  Enter this secret manually, using 6 digits, SHA1 and a
                  30-second period.
                </p>
                <code className="secret">{secret}</code>
              </div>
            )}
            {(!setup || secret) && (
              <label>
                Authenticator code
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  pattern="[0-9]{6}"
                />
              </label>
            )}
          </Form>
        )}
      </section>
      <p className="auth-foot">
        Debian-first development milestone · TLS 1.3 · No default credentials
      </p>
    </main>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null),
    [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ user: User; csrfToken: string }>("/api/session")
      .then((v) => {
        if (alive) {
          csrf(v.csrfToken);
          setUser(v.user);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);
  if (!ready)
    return (
      <main className="auth">
        <p>Loading secure session…</p>
      </main>
    );
  if (!user) return <Auth onLogin={setUser} />;
  // Each authenticated mount owns its data; late responses from an unmounted
  // session cannot populate a later account's dashboard.
  return <Dashboard key={user.id} user={user} onLogout={() => setUser(null)} />;
}

function unavailableHost(h: Host): Host {
  return {
    ...h,
    connectivity: h.revoked ? "revoked" : "unknown",
    freshness: h.latest ? "stale" : "unknown",
    resourceHealth: "unknown",
  };
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [hosts, setHosts] = useState<Host[]>([]),
    [canary, setCanary] = useState<Canary>({
      sources: [],
      mappings: [],
      now: 0,
    }),
    [jobs, setJobs] = useState<Job[]>([]),
    [audit, setAudit] = useState<Audit[]>([]),
    [view, setView] = useState("fleet"),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<{ host: Host; samples: Reading[] } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState(""),
    [result, setResult] = useState<Job | null>(null),
    [modal, setModal] = useState<
      "enroll" | "reboot" | "revoke" | "auth" | null
    >(null),
    [invitation, setInvitation] = useState<{
      hostId: string;
      invitation: string;
      expiresAt: number;
    } | null>(null),
    [busy, setBusy] = useState(false);
  async function refresh() {
    const [h, c, j, a] = await Promise.all([
      api<{ hosts: Host[] }>("/api/hosts"),
      api<Canary>("/api/canary"),
      api<Job[]>("/api/jobs"),
      api<Audit[]>("/api/audit"),
    ]);
    setHosts(h.hosts);
    setCanary(c);
    setJobs(j);
    setAudit(a);
  }
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await refresh();
        if (alive) setError("");
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setHosts((previous) => previous.map(unavailableHost));
          setDetail(
            (previous) =>
              previous && { ...previous, host: unavailableHost(previous.host) },
          );
          setCanary((previous) => ({
            ...previous,
            sources: previous.sources.map((source) => ({
              ...source,
              freshness: source.collectedAt ? "stale" : "unknown",
            })),
          }));
        }
      }
      if (alive) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [user]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const d = await api<{ host: Host; samples: Reading[] }>(
          `/api/hosts/${selected}`,
        );
        if (alive) setDetail(d);
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setDetail(
            (previous) =>
              previous && { ...previous, host: unavailableHost(previous.host) },
          );
          setHosts((previous) =>
            previous.map((host) =>
              host.id === selected ? unavailableHost(host) : host,
            ),
          );
        }
      }
      if (alive) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [selected, user]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openHost(id: string) {
    setSelected(id);
    setView("host");
    setDetail(null);
  }
  async function job(action: string, args: object = {}) {
    if (!selected) return;
    await act(async () => {
      await api(`/api/hosts/${selected}/jobs`, "POST", {
        action,
        args,
        confirm: action === "service.restart" ? selected : "",
      });
      setNotice(
        "Job queued. Its outcome will appear in Jobs and the activity timeline.",
      );
      setView("jobs");
    });
  }
  function theme() {
    const next =
      document.documentElement.dataset.mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.mode = next;
    try {
      localStorage.setItem("phoenix-theme", next);
    } catch {}
  }
  const current = detail?.host || hosts.find((h) => h.id === selected),
    reading = current?.latest;
  const filtered = hosts.filter((h) =>
    `${h.name} ${h.osVersion} ${h.addresses.join(" ")} ${h.groups.join(" ")} ${h.tags.join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const hostJobs =
    selected && view === "host"
      ? jobs.filter((j) => j.hostId === selected)
      : jobs;
  function mappings(h: Host) {
    return canary.mappings
      .filter((m) => m.hostId === h.id)
      .map((m) => ({
        source: canary.sources.find((s) => s.id === m.sourceId),
        monitor: canary.sources
          .find((s) => s.id === m.sourceId)
          ?.monitors.find((v) => v.monitor.id === m.monitorId),
        mapping: m,
      }));
  }
  function uptimeStatus(h: Host) {
    const ms = mappings(h);
    if (!ms.length) return "unmapped";
    if (
      ms.some((m) => !m.source || m.source.freshness !== "fresh" || !m.monitor)
    )
      return "unknown";
    if (ms.some((m) => m.monitor && monitorState(m.monitor) === "down"))
      return "down";
    if (ms.every((m) => m.monitor && monitorState(m.monitor) === "up"))
      return "up";
    return "unknown";
  }
  return (
    <div className="shell">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView("fleet");
          }}
        >
          <img src="/phoenix.svg" width="40" height="40" alt="" />
          <span>
            Phoenix<small>INFRASTRUCTURE</small>
          </span>
        </a>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {[
            ["fleet", "Fleet overview"],
            ["jobs", "Remote jobs"],
            ["activity", "Activity & audit"],
            ["canary", "Uptime Canary"],
            ...(user.role === "admin" ? [["access", "Access & accounts"]] : []),
          ].map(([key, label]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => setView(key)}
            >
              {label}
              {key === "fleet" && <small>{hosts.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="companion">
            <span className="status-dot" /> Independent monitoring
            <small>Powered by Uptime Canary</small>
          </div>
          <p>
            Debian / systemd milestone
            <br />
            0.1.0-dev
          </p>
          <button onClick={theme}>Switch appearance</button>
          <div className="account">
            <span>
              {user.name}
              <small>{user.role} · MFA enabled</small>
            </span>
            <button
              onClick={() =>
                void act(async () => {
                  await api("/api/auth/logout", "POST", {});
                  csrf("");
                  onLogout();
                })
              }
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace{" "}
            <span className="muted">
              /{" "}
              {view === "host"
                ? current?.name || "Host"
                : view === "fleet"
                  ? "Fleet overview"
                  : view}
            </span>
          </span>
          <button onClick={() => setModal("auth")}>Verify identity</button>
          <span className="muted">TLS protected · {user.role}</span>
        </header>
        <main id="content">
          <div aria-live="polite">
            {error && (
              <div className="notice error" role="alert">
                {error}
                <button onClick={() => setError("")} aria-label="Dismiss error">
                  ×
                </button>
              </div>
            )}
            {notice && <div className="notice">{notice}</div>}
          </div>
          {view === "fleet" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR INFRASTRUCTURE, AT A GLANCE</p>
                  <h1>Fleet overview</h1>
                  <p className="muted">
                    Uptime, management connectivity and resource health — each
                    with its own evidence.
                  </p>
                </div>
                {user.role === "admin" && (
                  <button
                    className="primary"
                    onClick={() => {
                      setInvitation(null);
                      setModal("enroll");
                    }}
                  >
                    + Enroll a host
                  </button>
                )}
              </div>
              <div className="metrics">
                <Metric
                  label="Managed hosts"
                  value={hosts.length}
                  detail="Independently enrolled identities"
                />
                <Metric
                  label="Agent connected"
                  value={`${hosts.filter((h) => h.connectivity === "connected").length} / ${hosts.length}`}
                  detail="Last contact within 45 seconds"
                />
                <Metric
                  label="Fresh telemetry"
                  value={`${hosts.filter((h) => h.freshness === "fresh").length} / ${hosts.length}`}
                  detail="Measured and collected within 90 seconds"
                />
                <Metric
                  label="Canary sources"
                  value={
                    canary.sources.length
                      ? `${canary.sources.filter((s) => s.freshness === "fresh").length} / ${canary.sources.length}`
                      : "Not configured"
                  }
                  detail="Independent uptime observations"
                />
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    Hosts <span className="count">{hosts.length}</span>
                  </h2>
                  <input
                    className="search"
                    aria-label="Search hosts"
                    placeholder="Search name, address, tag or group…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {!hosts.length ? (
                  <Empty>
                    <h3>Your fleet starts here</h3>
                    <p>
                      Enroll a Debian host to collect real telemetry. No host
                      has been added yet.
                    </p>
                    {user.role === "admin" && (
                      <button
                        onClick={() => {
                          setInvitation(null);
                          setModal("enroll");
                        }}
                      >
                        Create an enrollment invitation
                      </button>
                    )}
                  </Empty>
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Host</th>
                          <th>Canary uptime</th>
                          <th>Management</th>
                          <th>Telemetry</th>
                          <th>CPU</th>
                          <th>Memory</th>
                          <th>Disk /</th>
                          <th>Network activity</th>
                          <th>Machine uptime</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((h) => (
                          <tr key={h.id}>
                            <td>
                              <button
                                className="text-link"
                                onClick={() => openHost(h.id)}
                              >
                                {h.name}
                              </button>
                              <small>
                                {h.osVersion || "Awaiting enrollment"} ·{" "}
                                {h.addresses[0] || "No address"}
                              </small>
                              <div>
                                {h.groups.map((g) => (
                                  <span className="tag" key={g}>
                                    {g}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td>
                              <Tone value={uptimeStatus(h)} />
                              <small>
                                {mappings(h).length} mapped monitors
                              </small>
                            </td>
                            <td>
                              <Tone value={h.connectivity} />
                              <small>{stamp(h.lastContact)}</small>
                            </td>
                            <td>
                              <Tone value={h.freshness} />
                              <small>
                                Measured {stamp(h.latest?.measuredAt || 0)}
                              </small>
                            </td>
                            <td>
                              <Usage
                                value={h.latest?.cpuPercent ?? null}
                                stale={h.freshness !== "fresh"}
                              />
                            </td>
                            <td>
                              <Usage
                                value={
                                  h.latest?.memoryTotal
                                    ? (100 * h.latest.memoryUsed) /
                                      h.latest.memoryTotal
                                    : null
                                }
                                stale={h.freshness !== "fresh"}
                              />
                            </td>
                            <td>
                              <Usage
                                value={
                                  h.latest?.diskTotal
                                    ? (100 * h.latest.diskUsed) /
                                      h.latest.diskTotal
                                    : null
                                }
                                stale={h.freshness !== "fresh"}
                              />
                            </td>
                            <td>
                              {h.latest?.networkRxBps != null
                                ? bytes(h.latest.networkRxBps) + "/s"
                                : "Unknown"}
                              <small>
                                Received per second
                                {h.freshness !== "fresh" ? " ? last known" : ""}
                              </small>
                            </td>
                            <td>
                              {h.latest
                                ? uptime(h.latest.uptimeSeconds)
                                : "Unknown"}
                              <small>
                                {h.freshness === "stale"
                                  ? "Last known reading"
                                  : ""}
                              </small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <p className="footnote">
                An offline agent does not prove a host is down. Unknown or stale
                Canary data is never shown as healthy.
              </p>
            </>
          )}
          {view === "host" &&
            (!current ? (
              <Empty>Loading host…</Empty>
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <button
                      className="text-link"
                      onClick={() => setView("fleet")}
                    >
                      ← All hosts
                    </button>
                    <h1>{current.name}</h1>
                    <p className="muted">
                      {!current.verified
                        ? "Identity verification pending ? "
                        : ""}
                      {current.osVersion} · {current.addresses.join(", ")} ·{" "}
                      {current.connectionMethod}
                    </p>
                    <code>{current.id}</code>
                  </div>
                  <div className="button-row">
                    {user.role === "admin" &&
                      !current.verified &&
                      !current.revoked && (
                        <button
                          className="primary"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Compare the host ID and certificate fingerprint through a trusted channel using phoenix-agent identity. Fingerprint: ${current.certificateFingerprint}. Approve this exact identity?`,
                              )
                            )
                              void act(async () => {
                                await api(
                                  `/api/hosts/${current.id}/approve`,
                                  "POST",
                                  {
                                    confirm: current.id,
                                    certificateFingerprint:
                                      current.certificateFingerprint,
                                  },
                                );
                                setNotice("Enrolled identity verified.");
                              });
                          }}
                        >
                          Verify enrolled identity
                        </button>
                      )}
                    {user.role !== "viewer" && (
                      <>
                        <button
                          onClick={() =>
                            void job("diagnostic", {
                              diagnostic: "system.summary",
                            })
                          }
                          disabled={busy}
                        >
                          Run diagnostic
                        </button>
                        <button
                          className="danger"
                          onClick={() => setModal("reboot")}
                        >
                          Reboot host
                        </button>
                      </>
                    )}
                    {user.role === "admin" && (
                      <button
                        className="danger"
                        onClick={() => setModal("revoke")}
                      >
                        Revoke agent
                      </button>
                    )}
                  </div>
                </div>
                <div className="metrics">
                  <Metric
                    label="Canary uptime"
                    value={<Tone value={uptimeStatus(current)} />}
                    detail="Independent monitoring"
                  />
                  <Metric
                    label="Management"
                    value={<Tone value={current.connectivity} />}
                    detail={`Contact ${stamp(current.lastContact)}`}
                  />
                  <Metric
                    label="Telemetry"
                    value={<Tone value={current.freshness} />}
                    detail={`Collected ${stamp(reading?.collectedAt || 0)}`}
                  />
                  <Metric
                    label="Resource health"
                    value={<Tone value={current.resourceHealth} />}
                    detail="Requires complete fresh readings"
                  />
                </div>
                {reading && (
                  <>
                    <div className="metrics">
                      <Metric
                        label="CPU"
                        value={
                          reading.cpuPercent === null
                            ? "Sampling…"
                            : `${reading.cpuPercent.toFixed(1)}%`
                        }
                        detail={`Measured ${stamp(reading.measuredAt)}`}
                      />
                      <Metric
                        label="Memory"
                        value={`${bytes(reading.memoryUsed)} / ${bytes(reading.memoryTotal)}`}
                      />
                      <Metric
                        label="Disk /"
                        value={`${bytes(reading.diskUsed)} / ${bytes(reading.diskTotal)}`}
                      />
                      <Metric
                        label="Network counters"
                        value={bytes(reading.networkRx)}
                        detail={`Received · sent ${bytes(reading.networkTx)} · since boot`}
                      />
                    </div>
                    {!!reading.collectionErrors?.length && (
                      <p className="notice">
                        Incomplete collection:{" "}
                        {reading.collectionErrors.join("; ")}
                      </p>
                    )}
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>CPU history</h2>
                        <span className="muted">
                          At most 240 readings · gaps stay unknown
                        </span>
                      </div>
                      <History samples={detail?.samples || []} />
                    </section>
                  </>
                )}
                <div className="two-columns">
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>systemd services</h2>
                      <span className="muted">Read-only snapshot</span>
                    </div>
                    {!reading?.services.length ? (
                      <Empty>No service readings available.</Empty>
                    ) : (
                      <div className="table-scroll bounded">
                        <table>
                          <thead>
                            <tr>
                              <th>Service</th>
                              <th>State</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reading.services.map((s) => (
                              <tr key={s.name}>
                                <td>
                                  <code>{s.name}</code>
                                  <small>
                                    {s.load} / {s.sub}
                                  </small>
                                </td>
                                <td>{s.active}</td>
                                <td className="button-row">
                                  {user.role !== "viewer" && (
                                    <>
                                      <button
                                        onClick={() =>
                                          void job("logs.read", {
                                            service: s.name,
                                          })
                                        }
                                      >
                                        Logs
                                      </button>
                                      <button
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              `Request a restart of ${s.name} on ${current.name}? The agent's local allowlist must permit it.`,
                                            )
                                          )
                                            void job("service.restart", {
                                              service: s.name,
                                            });
                                        }}
                                      >
                                        Restart
                                      </button>
                                    </>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Processes</h2>
                      <span className="muted">Top 100 by resident memory</span>
                    </div>
                    {!reading?.processes.length ? (
                      <Empty>No process readings available.</Empty>
                    ) : (
                      <div className="table-scroll bounded">
                        <table>
                          <thead>
                            <tr>
                              <th>PID</th>
                              <th>Name</th>
                              <th>Memory</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reading.processes.map((p) => (
                              <tr key={p.pid}>
                                <td>{p.pid}</td>
                                <td>{p.name}</td>
                                <td>{bytes(p.memoryBytes)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </div>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Canary monitor mapping</h2>
                    <span className="muted">Source + monitor identity</span>
                  </div>
                  <div className="panel-body">
                    {user.role === "admin" ? (
                      <MappingForm
                        host={current}
                        canary={canary}
                        save={(body) =>
                          void act(async () => {
                            await api(
                              `/api/hosts/${current.id}/mappings`,
                              "PUT",
                              body,
                            );
                            setNotice("Monitor mappings saved.");
                          })
                        }
                      />
                    ) : (
                      mappings(current).map((m) => (
                        <p key={`${m.mapping.sourceId}/${m.mapping.monitorId}`}>
                          {m.mapping.sourceId} /{" "}
                          {m.monitor?.monitor.name || m.mapping.monitorId}
                        </p>
                      ))
                    )}
                  </div>
                </section>
                {user.role === "admin" && (
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Inventory</h2>
                      <span className="muted">
                        Certificate generation {current.generation} · agent{" "}
                        {current.agentVersion || "unknown"}
                      </span>
                    </div>
                    <div className="panel-body">
                      <p>
                        Certificate fingerprint{" "}
                        <code className="wrap">
                          {current.certificateFingerprint ||
                            "Awaiting enrollment"}
                        </code>
                      </p>
                      <Form
                        key={current.id}
                        onSubmit={(e) => {
                          const f = field(e);
                          void act(async () => {
                            await api(`/api/hosts/${current.id}`, "PATCH", {
                              name: f.get("name"),
                              tags: list(String(f.get("tags"))),
                              groups: list(String(f.get("groups"))),
                            });
                            setNotice("Inventory saved.");
                          });
                        }}
                      >
                        <label>
                          Display name
                          <input
                            name="name"
                            defaultValue={current.name}
                            required
                          />
                        </label>
                        <label>
                          Tags (comma separated)
                          <input
                            name="tags"
                            defaultValue={current.tags.join(", ")}
                          />
                        </label>
                        <label>
                          Groups (changes permission scopes)
                          <input
                            name="groups"
                            defaultValue={current.groups.join(", ")}
                          />
                        </label>
                      </Form>
                    </div>
                  </section>
                )}
                <Jobs
                  jobs={hostJobs}
                  hosts={hosts}
                  open={(id) =>
                    void act(async () =>
                      setResult(await api<Job>(`/api/jobs/${id}`)),
                    )
                  }
                  cancel={(id) =>
                    void act(async () => {
                      await api(`/api/jobs/${id}/cancel`, "POST", {});
                      setNotice(
                        "Cancellation requested; an executed action cannot be undone.",
                      );
                    })
                  }
                  canManage={user.role !== "viewer"}
                />
                <Activity
                  audit={audit.filter((a) => a.hostId === current.id)}
                />
              </>
            ))}
          {view === "jobs" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">DURABLE OPERATIONS</p>
                  <h1>Remote jobs</h1>
                  <p className="muted">
                    Accepted, completed and uncertain are different outcomes.
                    Uncertain actions are never automatically repeated.
                  </p>
                </div>
              </div>
              <Jobs
                jobs={jobs}
                hosts={hosts}
                open={(id) =>
                  void act(async () =>
                    setResult(await api<Job>(`/api/jobs/${id}`)),
                  )
                }
                cancel={(id) =>
                  void act(async () => {
                    await api(`/api/jobs/${id}/cancel`, "POST", {});
                  })
                }
                canManage={user.role !== "viewer"}
              />
            </>
          )}
          {view === "activity" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">ACCOUNTABILITY</p>
                  <h1>Activity & audit</h1>
                  <p className="muted">
                    Actors, targets, authorized actions and outcomes.
                    Credentials and command output are excluded.
                  </p>
                </div>
              </div>
              <Activity audit={audit} />
            </>
          )}
          {view === "canary" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">INDEPENDENT MONITORING</p>
                  <h1>Uptime Canary</h1>
                  <p className="muted">
                    Read-only status, preserved by source and observing node.
                    Configure trusted node origins on the server.
                  </p>
                </div>
              </div>
              {!canary.sources.length ? (
                <section className="panel">
                  <Empty>
                    <h3>No verified source configured</h3>
                    <p>
                      The NetBird-protected deployment has not been verified.
                      Follow docs/canary.md to connect a node API with its
                      dedicated viewer credential.
                    </p>
                  </Empty>
                </section>
              ) : (
                canary.sources.map((s) => (
                  <section className="panel" key={s.id}>
                    <div className="panel-heading">
                      <h2>
                        {s.id} <Tone value={s.freshness} />
                      </h2>
                      <span>{s.node.name || s.node.id}</span>
                    </div>
                    <div className="panel-body">
                      <p>
                        Measured {stamp(s.measuredAt)} · collected{" "}
                        {stamp(s.collectedAt)}
                      </p>
                      {s.error && <p className="notice">{s.error}</p>}
                      <code>Verified revision {s.revision}</code>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Monitor</th>
                            <th>Source state</th>
                            <th>Observing node</th>
                            <th>Measurement</th>
                            <th>Maintenance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.monitors.flatMap((m) =>
                            (m.observations?.length
                              ? m.observations
                              : [null]
                            ).map((o, i) => (
                              <tr key={`${m.monitor.id}-${i}`}>
                                <td>
                                  {m.monitor.name}
                                  <small>{m.monitor.id}</small>
                                </td>
                                <td>
                                  <Tone
                                    value={
                                      s.freshness === "fresh" &&
                                      (!o ||
                                        Date.now() - o.checkedAt <=
                                          Math.max(
                                            90000,
                                            3 * m.monitor.intervalMs,
                                          ))
                                        ? o?.state || monitorState(m)
                                        : "unknown"
                                    }
                                  />
                                  {s.freshness !== "fresh" && (
                                    <small>
                                      Last known: {o?.state || m.state}
                                    </small>
                                  )}
                                </td>
                                <td>{o?.nodeId || "Unknown"}</td>
                                <td>{stamp(o?.checkedAt || 0)}</td>
                                <td>
                                  {m.maintenanceIds?.join(", ") ||
                                    "None reported"}
                                </td>
                              </tr>
                            )),
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))
              )}
            </>
          )}
          {view === "access" && user.role === "admin" && <Access act={act} />}
        </main>
        <footer>
          Phoenix{" "}
          <span>
            Debian-first development build · Actual Debian acceptance pending
          </span>
        </footer>
      </div>
      {modal && (
        <div className="modal-backdrop">
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="close"
              aria-label="Close"
              onClick={() => {
                setModal(null);
                setInvitation(null);
              }}
            >
              ×
            </button>
            <h2 id="modal-title">
              {modal === "enroll"
                ? "Enroll a host"
                : modal === "auth"
                  ? "Verify your identity"
                  : modal === "reboot"
                    ? "Confirm host reboot"
                    : "Revoke agent identity"}
            </h2>
            {modal === "auth" ? (
              <Form
                submit="Verify password and MFA"
                busy={busy}
                onSubmit={(e) => {
                  const f = field(e);
                  void act(async () => {
                    await api("/api/auth/recent", "POST", {
                      password: f.get("password"),
                      code: f.get("code"),
                    });
                    setModal(null);
                    setNotice(
                      "Identity verified for five minutes. Use a new authenticator code for subsequent verification.",
                    );
                  });
                }}
              >
                <label>
                  Your password
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </label>
                <label>
                  New authenticator code
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    pattern="[0-9]{6}"
                  />
                </label>
              </Form>
            ) : modal === "enroll" ? (
              invitation ? (
                <>
                  <p>
                    Save this invitation in a private file on the target
                    machine. It is single use and expires at{" "}
                    {stamp(invitation.expiresAt)}.
                  </p>
                  <label>
                    Invitation
                    <textarea
                      className="secret"
                      readOnly
                      value={invitation.invitation}
                    />
                  </label>
                  <p>Expected host identity</p>
                  <code className="wrap">{invitation.hostId}</code>
                  <p>
                    Install the agent and trusted CA using the installation
                    guide, then run:
                  </p>
                  <pre>
                    phoenix-agent enroll -config /etc/phoenix/agent.json
                    -invitation-file /run/phoenix-enrollment
                  </pre>
                  <p className="muted">
                    Verify the expected identity after enrollment. Grant
                    operators access using Access & accounts.
                  </p>
                </>
              ) : (
                <Form
                  submit="Create invitation"
                  busy={busy}
                  onSubmit={(e) => {
                    const f = field(e);
                    void act(async () => {
                      const v = await api<{
                        hostId: string;
                        invitation: string;
                        expiresAt: number;
                      }>("/api/invitations", "POST", {
                        name: f.get("name"),
                        groups: list(String(f.get("groups"))),
                        reenrollHost: f.get("reenrollHost"),
                        confirm: f.get("reenrollHost"),
                      });
                      setInvitation(v);
                    });
                  }}
                >
                  <label>
                    Host display name
                    <input name="name" required maxLength={80} />
                  </label>
                  <label>
                    Groups (comma separated)
                    <input name="groups" />
                  </label>
                  <label>
                    Revoked host ID for deliberate re-enrollment (optional)
                    <input name="reenrollHost" autoComplete="off" />
                  </label>
                </Form>
              )
            ) : (
              <>
                <p>
                  {modal === "reboot"
                    ? `Request a reboot of ${current?.name}. Acknowledgement is not proof of a completed reboot. A new boot ID is required.`
                    : `Terminate ${current?.name}'s management connections and block further jobs. Any action already executed cannot be undone.`}
                </p>
                <p>Type this host ID to confirm:</p>
                <code className="wrap">{selected}</code>
                <Form
                  submit={
                    modal === "reboot"
                      ? "Authenticate and request reboot"
                      : "Authenticate and revoke"
                  }
                  busy={busy}
                  onSubmit={(e) => {
                    const f = field(e);
                    const operation = modal;
                    void act(async () => {
                      if (String(f.get("confirm")) !== selected)
                        throw new Error("Host ID does not match.");
                      await api("/api/auth/recent", "POST", {
                        password: f.get("password"),
                        code: f.get("code"),
                      });
                      if (operation === "reboot") {
                        await api(`/api/hosts/${selected}/jobs`, "POST", {
                          action: "host.reboot",
                          args: {},
                          confirm: selected,
                        });
                        setView("jobs");
                        setNotice(
                          "Reboot queued. Check acceptance and boot observation separately.",
                        );
                      } else
                        await api(`/api/hosts/${selected}/revoke`, "POST", {
                          confirm: selected,
                        });
                      setModal(null);
                    });
                  }}
                >
                  <label>
                    Host ID
                    <input name="confirm" required autoComplete="off" />
                  </label>
                  <label>
                    Your password
                    <input
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                    />
                  </label>
                  <label>
                    New authenticator code
                    <input
                      name="code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      required
                      pattern="[0-9]{6}"
                    />
                    <small>
                      A code already used to sign in cannot be reused.
                    </small>
                  </label>
                </Form>
              </>
            )}
          </section>
        </div>
      )}
      {result && (
        <div className="modal-backdrop">
          <section
            className="modal panel wide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="result-title"
          >
            <button
              className="close"
              aria-label="Close"
              onClick={() => setResult(null)}
            >
              ×
            </button>
            <h2 id="result-title">
              {result.action} <Tone value={result.state} />
            </h2>
            <p>
              Job <code>{result.id}</code>
            </p>
            <p>
              Created {stamp(result.createdAt)} · dispatched{" "}
              {stamp(result.dispatchedAt)} · finished {stamp(result.finishedAt)}
            </p>
            {result.action === "host.reboot" && (
              <p>
                New boot observed:{" "}
                <b>{result.rebootObserved ? "Yes" : "Not observed"}</b>
              </p>
            )}
            {result.result ? (
              <>
                <p>
                  Exit status {result.result.exitCode}{" "}
                  {result.result.truncated && "· output truncated"}
                </p>
                <h3>stdout</h3>
                <pre>{result.result.stdout || "(empty)"}</pre>
                <h3>stderr</h3>
                <pre>{result.result.stderr || "(empty)"}</pre>
              </>
            ) : (
              <p>
                Output is pending or your account does not have the output
                permission.
              </p>
            )}
            <p className="muted">
              Command output may contain secrets. It is accessible only with an
              explicit output grant.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Usage({ value, stale }: { value: number | null; stale: boolean }) {
  return value === null ? (
    <span className="muted">Unknown</span>
  ) : (
    <div className={stale ? "usage stale" : "usage"}>
      <b>{value.toFixed(1)}%</b>
      <meter
        min={0}
        max={100}
        value={value}
        aria-label={`${value.toFixed(1)} percent`}
      />
      {stale && <small>Last known</small>}
    </div>
  );
}
function History({ samples }: { samples: Reading[] }) {
  const ordered = [...samples].reverse(),
    valid = ordered.filter((s) => s.cpuPercent !== null);
  if (valid.length < 2)
    return <Empty>Two measured CPU readings are needed to draw history.</Empty>;
  const lo = ordered[0].measuredAt,
    hi = ordered[ordered.length - 1].measuredAt;
  const parts: string[] = [];
  let part = "";
  let last = 0;
  for (const s of ordered) {
    if (s.cpuPercent === null || (last && s.measuredAt - last > 90000)) {
      if (part) parts.push(part);
      part = "";
    }
    if (s.cpuPercent !== null)
      part += `${20 + ((s.measuredAt - lo) / Math.max(1, hi - lo)) * 960},${160 - s.cpuPercent * 1.4} `;
    last = s.measuredAt;
  }
  if (part) parts.push(part);
  return (
    <div className="history">
      <svg
        viewBox="0 0 1000 180"
        role="img"
        aria-label="CPU usage history, percent from 0 to 100. Gaps have no line."
      >
        <path className="grid" d="M20 20H980M20 90H980M20 160H980" />
        {parts.map((p, i) => (
          <polyline key={i} points={p} fill="none" className="history-line" />
        ))}
      </svg>
      <div className="history-labels">
        <small>{stamp(lo)}</small>
        <small>0–100% CPU · no interpolation across gaps</small>
        <small>{stamp(hi)}</small>
      </div>
    </div>
  );
}
function Jobs({
  jobs,
  hosts,
  open,
  cancel,
  canManage,
}: {
  jobs: Job[];
  hosts: Host[];
  open: (id: string) => void;
  cancel: (id: string) => void;
  canManage: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Jobs</h2>
        <span className="muted">Latest 200 · output permission required</span>
      </div>
      {!jobs.length ? (
        <Empty>No management jobs yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Host</th>
                <th>State</th>
                <th>Created</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <button className="text-link" onClick={() => open(j.id)}>
                      {j.action}
                    </button>
                    <small>
                      {j.args.service || j.args.diagnostic || j.id.slice(0, 12)}
                    </small>
                  </td>
                  <td>
                    {hosts.find((h) => h.id === j.hostId)?.name || j.hostId}
                  </td>
                  <td>
                    <Tone value={j.state} />
                    {j.cancelRequested && <small>Cancellation requested</small>}
                  </td>
                  <td>{stamp(j.createdAt)}</td>
                  <td>
                    {j.action === "host.reboot" && (
                      <small>
                        New boot:{" "}
                        {j.rebootObserved ? "observed" : "not observed"}
                      </small>
                    )}
                    {canManage &&
                      ["queued", "dispatched"].includes(j.state) && (
                        <button onClick={() => cancel(j.id)}>Cancel</button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function Activity({ audit }: { audit: Audit[] }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Activity timeline</h2>
        <span className="muted">Latest 500 · retained 90 days</span>
      </div>
      {!audit.length ? (
        <Empty>No activity in view.</Empty>
      ) : (
        <ol className="timeline">
          {audit.map((a) => (
            <li key={a.id}>
              <span className="timeline-dot" />
              <div>
                <strong>{a.action}</strong> <Tone value={a.state} />
                <small>
                  {stamp(a.at)} · actor {a.actor.slice(0, 12)}
                  {a.hostId && ` · host ${a.hostId.slice(0, 12)}`}
                  {a.jobId && ` · job ${a.jobId.slice(0, 12)}`}
                </small>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
function MappingForm({
  host,
  canary,
  save,
}: {
  host: Host;
  canary: Canary;
  save: (b: unknown) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(
    () =>
      setSelected(
        canary.mappings
          .filter((m) => m.hostId === host.id)
          .map((m) => `${m.sourceId}/${m.monitorId}`),
      ),
    [host.id, JSON.stringify(canary.mappings)],
  );
  if (!canary.sources.length)
    return (
      <p className="muted">
        Configure a verified Canary node source on the server first.
      </p>
    );
  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        save({
          mappings: selected.map((v) => {
            const [sourceId, monitorId] = v.split("/");
            return { sourceId, monitorId };
          }),
        });
      }}
      submit="Save monitor mappings"
    >
      {canary.sources.map((s) => (
        <fieldset key={s.id}>
          <legend>
            {s.id} · {s.node.name}
          </legend>
          {s.monitors.map((m) => {
            const value = `${s.id}/${m.monitor.id}`;
            return (
              <label className="check" key={value}>
                <input
                  type="checkbox"
                  checked={selected.includes(value)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, value]
                        : v.filter((x) => x !== value),
                    )
                  }
                />
                {m.monitor.name} <code>{m.monitor.id}</code>
              </label>
            );
          })}
        </fieldset>
      ))}
    </Form>
  );
}
function Access({ act }: { act: (fn: () => Promise<void>) => Promise<void> }) {
  const [users, setUsers] = useState<User[]>([]),
    [secret, setSecret] = useState("");
  useEffect(() => {
    void api<User[]>("/api/users").then(setUsers);
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LEAST PRIVILEGE</p>
          <h1>Access & accounts</h1>
          <p className="muted">
            Roles set the ceiling. Host, group and action grants determine
            access. New accounts start with no grants.
          </p>
        </div>
      </div>
      <div className="two-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>Create an account</h2>
          </div>
          <div className="panel-body">
            <Form
              submit="Create account"
              onSubmit={(e) => {
                const f = field(e);
                void act(async () => {
                  const v = await api<{ secret: string }>(
                    "/api/users",
                    "POST",
                    {
                      name: f.get("name"),
                      role: f.get("role"),
                      password: f.get("password"),
                    },
                  );
                  setSecret(v.secret);
                  setUsers(await api<User[]>("/api/users"));
                });
              }}
            >
              <label>
                Name
                <input name="name" required />
              </label>
              <label>
                Role
                <select name="role">
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                </select>
              </label>
              <label>
                Initial password
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={14}
                  maxLength={72}
                  required
                />
              </label>
            </Form>
            {secret && (
              <div className="notice">
                <p>
                  Share this authenticator secret through a trusted channel. It
                  is shown once.
                </p>
                <code className="secret">{secret}</code>
                <button onClick={() => setSecret("")}>Dismiss secret</button>
              </div>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Replace account grants</h2>
          </div>
          <div className="panel-body">
            <Form
              submit="Replace grants"
              onSubmit={(e) => {
                const f = field(e);
                void act(async () => {
                  await api(`/api/users/${f.get("user")}/grants`, "PUT", {
                    grants: f.getAll("actions").map((action) => ({
                      scopeType: f.get("scopeType"),
                      scope: f.get("scope"),
                      action,
                    })),
                  });
                });
              }}
            >
              <label>
                Account
                <select name="user">
                  {users
                    .filter((u) => u.role !== "admin")
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.role})
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Scope
                <select name="scopeType">
                  <option value="host">Host ID</option>
                  <option value="group">Group name</option>
                  <option value="all">All hosts (use *)</option>
                </select>
              </label>
              <label>
                Host ID, group name or *<input name="scope" required />
              </label>
              <fieldset>
                <legend>Allowed actions</legend>
                {[
                  "host.read",
                  "host.manage",
                  "diagnostic",
                  "services.inspect",
                  "logs.read",
                  "service.restart",
                  "host.reboot",
                  "jobs.output",
                  "jobs.cancel",
                ].map((a) => (
                  <label className="check" key={a}>
                    <input type="checkbox" name="actions" value={a} />
                    {a}
                  </label>
                ))}
              </fieldset>
              <small>
                This replaces all existing grants for this account. Viewer roles
                are restricted to host.read.
              </small>
            </Form>
          </div>
        </section>
      </div>
    </>
  );
}
