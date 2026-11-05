import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, csrf, ApiError } from "./api";
import type { Audit, Canary, Host, Job, Reading, User, Monitor } from "./types";
import {
  Dialog,
  ResponsiveDetails,
  Empty,
  ErrorNotice,
  Form,
  Metric,
  StatusNotice,
  Time,
  Tone,
  field,
  stamp,
  useNow,
} from "./ui";
import { Projects } from "./projects";
import { GrantEditor } from "./grants";
import {
  NavigationProvider,
  RouteLink,
  useNavigation,
  useUnsavedChanges,
} from "./navigation";

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
const needsAttention = (host: Host) =>
  host.connectivity === "offline" ||
  host.freshness === "stale" ||
  host.resourceHealth === "warning";
function resourceSummary(reading?: Reading | null) {
  if (!reading) return "No measurements available";
  const percentage = (value: number | null) =>
    value === null ? "Unknown" : `${value.toFixed(1)}%`;
  return `CPU ${percentage(reading.cpuPercent)} · Memory ${percentage(reading.memoryTotal ? (100 * reading.memoryUsed) / reading.memoryTotal : null)} · Disk ${percentage(reading.diskTotal ? (100 * reading.diskUsed) / reading.diskTotal : null)}`;
}
function SourceNotice({
  errors,
  view,
}: {
  errors: Record<string, string>;
  view: string;
}) {
  const entries = Object.entries(errors);
  if (!entries.length) return null;
  const label = (name: string) => (name === "Hosts" ? "Host inventory" : name);
  const affected = entries.some(([name]) =>
    (
      ({
        Hosts: ["fleet", "host"],
        Canary: ["fleet", "host", "canary"],
        Jobs: ["jobs", "host"],
        Activity: ["activity", "host"],
      })[name] || []
    ).includes(view),
  );
  return (
    <div
      className={`source-warning${affected ? " affected" : ""}`}
      role="alert"
    >
      <details open={affected}>
        <summary>
          {entries.map(([name]) => label(name)).join(", ")} unavailable · other
          sources continue updating
        </summary>
        <div>
          {entries.map(([name, message]) => (
            <p key={name}>
              <strong>{label(name)} unavailable:</strong> {message}.
            </p>
          ))}
          <small>
            Failed sources show last-loaded results; current state is unknown.
          </small>
        </div>
      </details>
    </div>
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
  return (
    <NavigationProvider key={user.id}>
      <Dashboard user={user} onLogout={() => setUser(null)} />
    </NavigationProvider>
  );
}

function unavailableHost(h: Host): Host {
  return {
    ...h,
    connectivity: h.revoked ? "revoked" : "unknown",
    freshness: h.latest ? "stale" : "unknown",
    resourceHealth: "unknown",
  };
}

// Only downgrade server classifications; a browser clock never makes old
// evidence healthy. Limits match hosts.go (45/90 s), canary.go (90 s).
const recentEvidence = (at: number, limit: number, now: number) =>
  at > 0 && at <= now + 30000 && now - at <= limit;
function ageHost(host: Host, now: number): Host {
  const freshness =
    host.freshness === "fresh" &&
    (!host.latest ||
      !recentEvidence(host.latest.measuredAt, 90000, now) ||
      !recentEvidence(host.latest.collectedAt, 90000, now))
      ? host.latest
        ? "stale"
        : "unknown"
      : host.freshness;
  return {
    ...host,
    connectivity:
      host.connectivity === "connected" &&
      !recentEvidence(host.lastContact, 44999, now)
        ? host.lastContact > now + 30000
          ? "unknown"
          : "offline"
        : host.connectivity,
    freshness,
    resourceHealth: freshness === "fresh" ? host.resourceHealth : "unknown",
  };
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const { route, navigate, canLeave } = useNavigation();
  const view = route.view,
    selected = view === "host" ? route.id || "" : "";
  const setView = (next: string) => {
    navigate({ view: next });
  };
  useEffect(() => {
    if (view === "access" && user.role !== "admin")
      navigate({ view: "fleet" }, { replace: true, force: true });
  }, [view, user.role, navigate]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const menu =
        document.querySelector<HTMLDetailsElement>(".mobile-navigation");
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const [hostsResponse, setHosts] = useState<Host[]>([]),
    [canaryResponse, setCanary] = useState<Canary>({
      sources: [],
      mappings: [],
      now: 0,
    }),
    [jobs, setJobs] = useState<Job[]>([]),
    [audit, setAudit] = useState<Audit[]>([]),
    [detail, setDetail] = useState<{ host: Host; samples: Reading[] } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [sourceErrors, setSourceErrors] = useState<Record<string, string>>({}),
    [sourceLoaded, setSourceLoaded] = useState<Record<string, boolean>>({}),
    [detailError, setDetailError] = useState(""),
    [modalError, setModalError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState(""),
    [attentionOnly, setAttentionOnly] = useState(false),
    [verificationUntil, setVerificationUntil] = useState(0),
    [verificationExpired, setVerificationExpired] = useState(false),
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
  const now = useNow();
  const hosts = hostsResponse.map((host) => ageHost(host, now));
  const canary = {
    ...canaryResponse,
    sources: canaryResponse.sources.map((source) => ({
      ...source,
      freshness:
        source.freshness === "fresh" &&
        (!recentEvidence(source.collectedAt, 90000, now) ||
          !recentEvidence(source.measuredAt, 90000, now))
          ? "stale"
          : source.freshness,
    })),
  };
  const mounted = useRef(false),
    versions = useRef<Record<string, number>>({});
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setModalError(""), [modal]);
  useEffect(() => {
    if (!verificationUntil) return;
    const expire = () => {
      if (Date.now() >= verificationUntil) {
        setVerificationUntil(0);
        setVerificationExpired(true);
      }
    };
    const timer = setTimeout(
      expire,
      Math.max(0, verificationUntil - Date.now()),
    );
    window.addEventListener("focus", expire);
    document.addEventListener("visibilitychange", expire);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", expire);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [verificationUntil]);
  useEffect(() => {
    document
      .querySelector<HTMLDetailsElement>(".mobile-navigation")
      ?.removeAttribute("open");
  }, [route.view, route.id]);
  async function readSource<T>(
    name: string,
    request: () => Promise<T>,
    apply: (value: T) => void,
    invalidate?: () => void,
  ) {
    const version = (versions.current[name] =
      (versions.current[name] || 0) + 1);
    try {
      const value = await request();
      if (!mounted.current || versions.current[name] !== version) return;
      apply(value);
      setSourceLoaded((previous) =>
        previous[name] ? previous : { ...previous, [name]: true },
      );
      setSourceErrors((previous) => {
        if (!previous[name]) return previous;
        const next = { ...previous };
        delete next[name];
        return next;
      });
    } catch (e) {
      if (!mounted.current || versions.current[name] !== version) return;
      setSourceErrors((previous) => ({
        ...previous,
        [name]: (e as Error).message,
      }));
      invalidate?.();
    }
  }
  function readers() {
    // Apply each response independently, keeping valid monitoring evidence
    // when another endpoint fails. Older overlapping reads cannot win.
    return [
      () =>
        readSource(
          "Hosts",
          () => api<{ hosts: Host[] }>("/api/hosts"),
          (value) => setHosts(value.hosts),
          () => setHosts((previous) => previous.map(unavailableHost)),
        ),
      () =>
        readSource(
          "Canary",
          () => api<Canary>("/api/canary"),
          setCanary,
          () =>
            setCanary((previous) => ({
              ...previous,
              sources: previous.sources.map((source) => ({
                ...source,
                freshness: source.collectedAt ? "stale" : "unknown",
              })),
            })),
        ),
      () => readSource("Jobs", () => api<Job[]>("/api/jobs"), setJobs),
      () => readSource("Activity", () => api<Audit[]>("/api/audit"), setAudit),
    ];
  }
  async function refresh() {
    await Promise.allSettled(readers().map((read) => read()));
  }
  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    readers().forEach((read, index) => {
      const poll = async () => {
        await read();
        if (alive) timers[index] = setTimeout(poll, 5000);
      };
      void poll();
    });
    return () => {
      alive = false;
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [user]);
  useEffect(() => {
    setDetailError("");
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
        if (alive) {
          setDetail(d);
          setDetailError("");
        }
      } catch (e) {
        if (alive) {
          setDetailError((e as Error).message);
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
    const inDialog = modal !== null;
    setBusy(true);
    if (inDialog) setModalError("");
    else setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      if (inDialog) {
        let recovery = "";
        if (modal === "auth") {
          recovery =
            e instanceof ApiError
              ? e.status === 429
                ? " Wait before trying again."
                : e.status === 401 || e.status === 403
                  ? " Check your password and current authenticator code. Wait for the next code if this one was already used."
                  : e.status >= 500
                    ? " Try again shortly. If this continues, contact your Phoenix administrator."
                    : ""
              : " Check your connection to Phoenix, then try again.";
        }
        setModalError((e as Error).message + recovery);
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
  function signOut() {
    if (!canLeave()) return;
    void act(async () => {
      try {
        await api("/api/auth/logout", "POST", {});
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
      csrf("");
      navigate({ view: "fleet" }, { replace: true, force: true });
      onLogout();
    });
  }
  const destinations = [
    ["fleet", "Fleet overview"],
    ["projects", "Projects"],
    ["jobs", "Remote jobs"],
    ["canary", "Uptime Canary"],
    ["activity", "Activity & audit"],
    ...(user.role === "admin" ? [["access", "Access & accounts"]] : []),
  ];
  const sectionName =
    destinations.find(([key]) => key === view)?.[1] || "Host details";
  const navigation = (mobile = false) => (
    <nav aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      {destinations.map(([key, label]) => (
        <RouteLink
          key={key}
          to={{ view: key }}
          className={
            view === key || (key === "fleet" && view === "host") ? "active" : ""
          }
          aria-current={
            view === key
              ? "page"
              : key === "fleet" && view === "host"
                ? "location"
                : undefined
          }
        >
          {label}
          {key === "fleet" && (
            <small>{sourceLoaded.Hosts ? hosts.length : "…"}</small>
          )}
        </RouteLink>
      ))}
    </nav>
  );
  const selectedDetail = detail?.host.id === selected ? detail : null;
  const current = selectedDetail
      ? ageHost(selectedDetail.host, now)
      : hosts.find((h) => h.id === selected),
    reading = current?.latest;
  const retainedReading = !!reading && current?.freshness !== "fresh";
  const attentionCount = hosts.filter(needsAttention).length;
  const filtered = hosts.filter(
    (h) =>
      (!attentionOnly || needsAttention(h)) &&
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
    if (!sourceLoaded.Canary)
      return sourceErrors.Canary ? "unknown" : "loading";
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
      <a
        className="skip"
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("content");
          if (main) {
            main.tabIndex = -1;
            main.focus();
          }
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <RouteLink className="brand" to={{ view: "fleet" }}>
          <img src="/phoenix.svg" width="40" height="40" alt="" />
          <span>
            Phoenix<small>INFRASTRUCTURE</small>
          </span>
        </RouteLink>
        <span className="nav-label">WORKSPACE</span>
        {navigation()}
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
            <button onClick={signOut}>Sign out</button>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="desktop-context">
            Workspace{" "}
            <span className="muted">
              /{" "}
              {view === "host"
                ? current?.name || "Host"
                : view === "fleet"
                  ? "Fleet overview"
                  : view === "projects"
                    ? "Projects"
                    : sectionName}
            </span>
          </span>
          <details
            className="mobile-navigation"
            onToggle={(event) => {
              if (event.currentTarget.open)
                event.currentTarget
                  .querySelector(".mobile-menu-body")
                  ?.scrollTo({ top: 0 });
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                event.currentTarget.open = false;
            }}
          >
            <summary>
              <span>Menu</span>
              <strong>{sectionName}</strong>
            </summary>
            <div className="mobile-menu-body">
              {navigation(true)}
              <div className="mobile-account">
                <b>{user.name}</b>
                <small>{user.role} · MFA enabled</small>
                <div className="button-row">
                  <button onClick={theme}>Switch appearance</button>
                  <button onClick={signOut}>Sign out</button>
                </div>
              </div>
            </div>
          </details>
          <button onClick={() => setModal("auth")}>Verify identity</button>
          <span className="muted">TLS protected · {user.role}</span>
        </header>
        <main id="content">
          <div aria-live="polite">
            {error && (
              <div className="notice error" role="alert">
                {error}
                <button
                  onClick={() => {
                    setError("");
                  }}
                  aria-label="Dismiss error"
                >
                  ×
                </button>
              </div>
            )}
            {notice && <div className="notice">{notice}</div>}
          </div>
          <SourceNotice errors={sourceErrors} view={view} />
          {view === "host" &&
            detailError &&
            detailError !== sourceErrors.Hosts && (
              <div className="notice error" role="alert">
                Host detail unavailable: {detailError}. Retained readings below
                are last known.
              </div>
            )}
          <StatusNotice>
            {verificationUntil ? (
              <>
                Identity verified. Verify again after{" "}
                <time dateTime={new Date(verificationUntil).toISOString()}>
                  {new Date(verificationUntil).toLocaleString(undefined, {
                    timeZoneName: "short",
                  })}
                </time>{" "}
                for sensitive actions.
              </>
            ) : verificationExpired ? (
              "Recent verification expired. Verify your identity again when prompted."
            ) : (
              ""
            )}
          </StatusNotice>
          {view === "fleet" && (
            <>
              <div className="page-heading fleet-heading">
                <div>
                  <p className="eyebrow">YOUR INFRASTRUCTURE, AT A GLANCE</p>
                  <h1>Fleet overview</h1>
                  <p className="muted">
                    Agent connections and resource readings. Canary uptime is
                    independent.
                  </p>
                </div>
                {user.role === "admin" && (
                  <button
                    className={
                      hosts.length ? "secondary enroll-existing" : "primary"
                    }
                    onClick={() => {
                      setInvitation(null);
                      setModal("enroll");
                    }}
                  >
                    + Enroll a host
                  </button>
                )}
              </div>
              <ResponsiveDetails
                className="fleet-summary"
                label={
                  <>
                    Fleet summary{" "}
                    <span className="muted">
                      {sourceLoaded.Hosts
                        ? `${hosts.length} hosts`
                        : sourceErrors.Hosts
                          ? "Unavailable"
                          : "Loading…"}
                    </span>
                  </>
                }
              >
                <div className="metrics">
                  <Metric
                    label="Managed hosts"
                    value={
                      sourceLoaded.Hosts
                        ? hosts.length
                        : sourceErrors.Hosts
                          ? "Unavailable"
                          : "Loading…"
                    }
                    detail="Enrolled in this workspace"
                  />
                  <Metric
                    label="Agent connected"
                    value={
                      sourceLoaded.Hosts
                        ? `${hosts.filter((h) => h.connectivity === "connected").length} / ${hosts.length}`
                        : "Awaiting inventory"
                    }
                    detail="Last contact within 45 seconds"
                  />
                  <Metric
                    label="Fresh readings"
                    value={
                      sourceLoaded.Hosts
                        ? `${hosts.filter((h) => h.freshness === "fresh").length} / ${hosts.length}`
                        : "Awaiting inventory"
                    }
                    detail="Measured and collected within 90 seconds"
                  />
                  <Metric
                    label="Canary sources"
                    value={
                      canary.sources.length
                        ? `${canary.sources.filter((s) => s.freshness === "fresh").length} / ${canary.sources.length}`
                        : sourceErrors.Canary
                          ? "Unavailable"
                          : !sourceLoaded.Canary
                            ? "Loading…"
                            : "Not configured"
                    }
                    detail="Independent uptime observations"
                  />
                </div>
              </ResponsiveDetails>
              <section className="panel">
                <div className="panel-heading">
                  <h2>
                    Hosts{" "}
                    <span className="count">
                      {sourceLoaded.Hosts ? hosts.length : "…"}
                    </span>
                  </h2>
                  <button
                    className="attention-filter"
                    disabled={!sourceLoaded.Hosts}
                    aria-pressed={attentionOnly}
                    onClick={() => setAttentionOnly(!attentionOnly)}
                    title="Offline agents, stale readings and resource warnings. Canary uptime is separate."
                  >
                    Agent / readings issues ({attentionCount})
                  </button>
                  <input
                    className="search"
                    aria-label="Search hosts"
                    placeholder="Search name, address, tag or group…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {attentionOnly && (
                  <p className="filter-context" role="status">
                    Offline agents, stale readings or resource warnings. Canary
                    uptime is separate.{" "}
                    <button
                      className="text-link"
                      onClick={() => setAttentionOnly(false)}
                    >
                      Show all hosts
                    </button>
                  </p>
                )}
                {!hosts.length ? (
                  <Empty>
                    <h3>
                      {sourceErrors.Hosts
                        ? "Host inventory unavailable"
                        : !sourceLoaded.Hosts
                          ? "Loading host inventory…"
                          : "Your fleet starts here"}
                    </h3>
                    <p>
                      {sourceErrors.Hosts
                        ? "Wait for the next successful read. No current inventory can be established."
                        : !sourceLoaded.Hosts
                          ? "Waiting for the first response. Inventory is not yet known."
                          : "Enroll a Debian host to collect real telemetry. No host has been added yet."}
                    </p>
                    {user.role === "admin" && sourceLoaded.Hosts && (
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
                ) : !filtered.length ? (
                  <Empty>
                    <h3>No matching hosts</h3>
                    <p>
                      Try another name, address, tag or group, or clear the
                      attention filter.
                    </p>
                    <button
                      onClick={() => {
                        setSearch("");
                        setAttentionOnly(false);
                      }}
                    >
                      Clear filters
                    </button>
                  </Empty>
                ) : (
                  <div className="table-scroll">
                    <table
                      role="table"
                      aria-colcount={5}
                      className="fleet-table responsive-table"
                    >
                      <caption className="sr-only">
                        Host inventory. Canary uptime, agent connection and
                        reading freshness are independent.
                      </caption>
                      <thead role="rowgroup">
                        <tr role="row">
                          <th role="columnheader" aria-colindex={1} scope="col">
                            Host
                          </th>
                          <th role="columnheader" aria-colindex={2} scope="col">
                            Canary uptime
                          </th>
                          <th role="columnheader" aria-colindex={3} scope="col">
                            Agent connection
                          </th>
                          <th role="columnheader" aria-colindex={4} scope="col">
                            Reading freshness
                          </th>
                          <th role="columnheader" aria-colindex={5} scope="col">
                            Resources
                          </th>
                        </tr>
                      </thead>
                      <tbody role="rowgroup">
                        {filtered.map((h) => (
                          <tr role="row" key={h.id}>
                            <td role="cell" aria-colindex={1} data-label="Host">
                              <div className="host-identity">
                                <RouteLink
                                  className="text-link"
                                  to={{ view: "host", id: h.id }}
                                >
                                  {h.name}
                                </RouteLink>
                                <span className="compact-freshness">
                                  <Tone
                                    value={h.freshness}
                                    label={`${h.freshness} readings`}
                                  />
                                </span>
                                {h.resourceHealth === "warning" && (
                                  <span className="mobile-resource-warning">
                                    <Tone
                                      value="warning"
                                      label="Resource warning"
                                    />
                                    <small>{resourceSummary(h.latest)}</small>
                                  </span>
                                )}
                              </div>
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
                            <td
                              role="cell"
                              aria-colindex={2}
                              data-label="Canary uptime"
                            >
                              <Tone value={uptimeStatus(h)} />
                              <small>
                                {mappings(h).length} mapped monitors
                              </small>
                            </td>
                            <td
                              role="cell"
                              aria-colindex={3}
                              data-label="Agent connection"
                            >
                              <Tone value={h.connectivity} />
                              <small>
                                Contact <Time value={h.lastContact} />
                              </small>
                            </td>
                            <td
                              role="cell"
                              aria-colindex={4}
                              data-label="Reading freshness"
                            >
                              <Tone value={h.freshness} />
                              <small>
                                <Time value={h.latest?.measuredAt || 0} />
                              </small>
                            </td>
                            <td
                              role="cell"
                              aria-colindex={5}
                              data-label="Resources"
                            >
                              {h.resourceHealth === "warning" && (
                                <span className="desktop-resource-warning">
                                  <Tone
                                    value="warning"
                                    label="Resource warning"
                                  />
                                </span>
                              )}
                              <ResponsiveDetails
                                className="resource-details"
                                label="Resource readings"
                              >
                                <small className="mobile-reading-time">
                                  Measured{" "}
                                  <Time value={h.latest?.measuredAt || 0} />
                                </small>
                                <div className="resource-summary">
                                  <div>
                                    <small>CPU</small>
                                    <Usage
                                      label="CPU"
                                      value={h.latest?.cpuPercent ?? null}
                                      stale={h.freshness !== "fresh"}
                                    />
                                  </div>
                                  <div>
                                    <small>Memory</small>
                                    <Usage
                                      label="Memory"
                                      value={
                                        h.latest?.memoryTotal
                                          ? (100 * h.latest.memoryUsed) /
                                            h.latest.memoryTotal
                                          : null
                                      }
                                      stale={h.freshness !== "fresh"}
                                    />
                                  </div>
                                  <div>
                                    <small>Disk /</small>
                                    <Usage
                                      label="Disk"
                                      value={
                                        h.latest?.diskTotal
                                          ? (100 * h.latest.diskUsed) /
                                            h.latest.diskTotal
                                          : null
                                      }
                                      stale={h.freshness !== "fresh"}
                                    />
                                  </div>
                                </div>
                                <details className="measurement-details">
                                  <summary>Network & uptime</summary>
                                  <div>
                                    {h.latest?.networkRxBps != null
                                      ? bytes(h.latest.networkRxBps) + "/s"
                                      : "Unknown"}
                                    {" received · "}
                                    {h.latest
                                      ? uptime(h.latest.uptimeSeconds)
                                      : "Unknown"}
                                    {" since boot"}
                                    {h.freshness !== "fresh" && " · last known"}
                                  </div>
                                </details>
                              </ResponsiveDetails>
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
              <>
                <div className="page-heading">
                  <div>
                    <h1 key="host-title">Host details</h1>
                  </div>
                </div>
                <Empty>
                  {detailError
                    ? "This host is unavailable or cannot be read by your account."
                    : "Loading host…"}
                </Empty>
              </>
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
                    <h1 key="host-title">{current.name}</h1>
                    <p className="muted">
                      {!current.verified
                        ? "Identity verification pending · "
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
                      </>
                    )}
                    {user.role !== "viewer" && (
                      <details className="host-actions" key={current.id}>
                        <summary>Manage host</summary>
                        <p className="muted">
                          Sensitive actions for {current.name}. Confirmation and
                          recent verification are required.
                        </p>
                        <div className="button-row">
                          <button
                            className="danger"
                            onClick={() => setModal("reboot")}
                          >
                            Reboot host
                          </button>
                          {user.role === "admin" && (
                            <button
                              className="danger"
                              onClick={() => setModal("revoke")}
                            >
                              Revoke agent
                            </button>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
                <div className="metrics host-status">
                  <Metric
                    label="Canary uptime"
                    value={<Tone value={uptimeStatus(current)} />}
                    detail="Independent monitoring"
                  />
                  <Metric
                    label="Agent connection"
                    value={<Tone value={current.connectivity} />}
                    detail={`Contact ${stamp(current.lastContact)}`}
                  />
                  <Metric
                    label="Reading freshness"
                    value={<Tone value={current.freshness} />}
                    detail={`Collected ${stamp(reading?.collectedAt || 0)}`}
                  />
                  <Metric
                    label="Resource health"
                    value={<Tone value={current.resourceHealth} />}
                    detail="Requires complete fresh readings"
                  />
                </div>
                {retainedReading && (
                  <p className="notice retained reading-snapshot" role="status">
                    <strong>Last known readings.</strong> Measured{" "}
                    {stamp(reading!.measuredAt)}. Resource values, service
                    states and processes below are a retained snapshot; current
                    state is unknown.
                  </p>
                )}
                {reading && (
                  <>
                    <div className="metrics host-resources">
                      <Metric
                        label="CPU"
                        retained={retainedReading}
                        value={
                          reading.cpuPercent === null
                            ? "Sampling…"
                            : `${reading.cpuPercent.toFixed(1)}%`
                        }
                        detail={`Measured ${stamp(reading.measuredAt)}`}
                      />
                      <Metric
                        label="Memory used"
                        retained={retainedReading}
                        value={
                          reading.memoryTotal ? (
                            <span className="quantity">
                              {bytes(reading.memoryUsed)}
                            </span>
                          ) : (
                            "Unknown"
                          )
                        }
                        detail={
                          reading.memoryTotal ? (
                            <>
                              of{" "}
                              <span className="quantity">
                                {bytes(reading.memoryTotal)}
                              </span>{" "}
                              total
                            </>
                          ) : (
                            "No memory reading"
                          )
                        }
                      />
                      <Metric
                        label="Disk used (/)"
                        retained={retainedReading}
                        value={
                          reading.diskTotal ? (
                            <span className="quantity">
                              {bytes(reading.diskUsed)}
                            </span>
                          ) : (
                            "Unknown"
                          )
                        }
                        detail={
                          reading.diskTotal ? (
                            <>
                              of{" "}
                              <span className="quantity">
                                {bytes(reading.diskTotal)}
                              </span>{" "}
                              total
                            </>
                          ) : (
                            "No disk reading"
                          )
                        }
                      />
                      <Metric
                        label="Network counters"
                        retained={retainedReading}
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
                    <section className="panel cpu-history">
                      <div className="panel-heading">
                        <h2>CPU history</h2>
                        <span className="muted">
                          At most 240 readings · gaps stay unknown
                        </span>
                      </div>
                      <History samples={selectedDetail?.samples || []} />
                    </section>
                  </>
                )}
                <div className="two-columns">
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>systemd services</h2>
                      <span className="muted">
                        {retainedReading
                          ? "Last known service snapshot"
                          : "Service state snapshot"}
                      </span>
                    </div>
                    {!reading?.services.length ? (
                      <Empty>No service readings available.</Empty>
                    ) : (
                      <div className="table-scroll bounded">
                        <table>
                          <thead>
                            <tr>
                              <th>Service</th>
                              <th>
                                {retainedReading ? "Last known state" : "State"}
                              </th>
                              <th>Agent requests</th>
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
                                <td>
                                  {current.connectivity !== "connected" &&
                                    user.role !== "viewer" && (
                                      <small className="agent-request-context">
                                        Agent{" "}
                                        {current.connectivity.replaceAll(
                                          "_",
                                          " ",
                                        )}
                                        . Requests need a connected agent;
                                        completion is not assured.
                                      </small>
                                    )}
                                  <div className="button-row">
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
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {retainedReading && (
                      <p className="snapshot-action-note">
                        Service states are last known and may have changed. Logs
                        and restart send new requests to this host’s agent;
                        restart still requires confirmation and the agent’s
                        allowlist.
                      </p>
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Processes</h2>
                      <span className="muted">
                        {retainedReading && "Last known · "}Top 100 by resident
                        memory
                      </span>
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
                  unavailable={!!sourceErrors.Jobs}
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
                  unavailable={!!sourceErrors.Activity}
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
                unavailable={!!sourceErrors.Jobs}
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
              <Activity audit={audit} unavailable={!!sourceErrors.Activity} />
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
                    <h3>
                      {sourceErrors.Canary
                        ? "Canary readings unavailable"
                        : !sourceLoaded.Canary
                          ? "Loading Canary sources…"
                          : "No verified source configured"}
                    </h3>
                    <p>
                      {sourceErrors.Canary
                        ? "The dashboard cannot establish current Canary configuration or observations. Wait for the next successful read."
                        : !sourceLoaded.Canary
                          ? "Waiting for the first response. Source configuration is not yet known."
                          : "Follow docs/canary.md to connect a verified node API with its dedicated viewer credential."}
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
          {view === "projects" && (
            <Projects user={user} onVerify={() => setModal("auth")} />
          )}
          {view === "access" && user.role === "admin" && (
            <Access hosts={hosts} onVerify={() => setModal("auth")} />
          )}
        </main>
        <footer>
          Phoenix{" "}
          <span>
            Debian-first development build · Actual Debian acceptance pending
          </span>
        </footer>
      </div>
      {modal && (
        <Dialog
          busy={busy}
          onClose={() => {
            setModal(null);
            setInvitation(null);
          }}
          title={
            modal === "enroll"
              ? "Enroll a host"
              : modal === "auth"
                ? "Verify your identity"
                : modal === "reboot"
                  ? "Confirm host reboot"
                  : "Revoke agent identity"
          }
        >
          {modalError && (
            <p className="notice error" role="alert">
              {modalError}
            </p>
          )}
          {modal === "auth" ? (
            <Form
              submit="Verify password and MFA"
              busy={busy}
              onSubmit={(e) => {
                const f = field(e);
                void act(async () => {
                  const checkedAt = Date.now();
                  await api("/api/auth/recent", "POST", {
                    password: f.get("password"),
                    code: f.get("code"),
                  });
                  setModal(null);
                  setVerificationUntil(checkedAt + 5 * 60 * 1000);
                  setVerificationExpired(false);
                });
              }}
            >
              <p className="muted">
                Sensitive changes, including access grants, repository
                credentials and reboots, require password and MFA verification
                within the last five minutes. After verifying, return to your
                action and try again.
              </p>
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
                Current code from your authenticator
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  pattern="[0-9]{6}"
                />
                <small>
                  Codes are single use. Wait for the next code if this one was
                  already used.
                </small>
              </label>
            </Form>
          ) : modal === "enroll" ? (
            invitation ? (
              <>
                <p>
                  Save this invitation in a private file on the target machine.
                  It is single use and expires at {stamp(invitation.expiresAt)}.
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
                  Install the agent and trusted CA using the installation guide,
                  then run:
                </p>
                <pre>
                  phoenix-agent enroll -config /etc/phoenix/agent.json
                  -invitation-file /run/phoenix-enrollment
                </pre>
                <p className="muted">
                  Verify the expected identity after enrollment. Grant operators
                  access using Access & accounts.
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
        </Dialog>
      )}
      {result && (
        <Dialog
          wide
          onClose={() => setResult(null)}
          title={
            <>
              {result.action} <Tone value={result.state} />
            </>
          }
        >
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
        </Dialog>
      )}
    </div>
  );
}

function Usage({
  value,
  stale,
  label,
}: {
  value: number | null;
  stale: boolean;
  label: string;
}) {
  return value === null ? (
    <span className="muted">Unknown</span>
  ) : (
    <div className={stale ? "usage stale" : "usage"}>
      <b>{value.toFixed(1)}%</b>
      <meter
        min={0}
        max={100}
        value={value}
        aria-label={`${label}: ${value.toFixed(1)} percent${stale ? ", last known" : ""}`}
      />
      {stale && <small>Last known</small>}
    </div>
  );
}
function History({ samples }: { samples: Reading[] }) {
  const ordered = samples.slice(0, 240).reverse(),
    valid = ordered.filter((s) => s.cpuPercent !== null);
  if (!ordered.length)
    return (
      <div className="history-empty">
        <Empty>
          No CPU readings yet. History appears after two measurements.
        </Empty>
      </div>
    );
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
      <p className="history-summary">
        {valid.length ? (
          <>
            Latest measured {valid.at(-1)!.cpuPercent!.toFixed(1)}% · range{" "}
            {Math.min(...valid.map((s) => s.cpuPercent!)).toFixed(1)}–
            {Math.max(...valid.map((s) => s.cpuPercent!)).toFixed(1)}% ·{" "}
            {valid.length} measured of {ordered.length} readings.
          </>
        ) : (
          "No measured CPU values in this window."
        )}
        {valid.length < 2 && " Two measurements are needed to draw history."}{" "}
        Gaps remain unknown.
      </p>
      {valid.length >= 2 && (
        <>
          <svg
            viewBox="0 0 1000 180"
            role="img"
            aria-label="CPU usage history, percent from 0 to 100. Gaps have no line."
          >
            <path className="grid" d="M20 20H980M20 90H980M20 160H980" />
            {parts.map((p, i) => (
              <polyline
                key={i}
                points={p}
                fill="none"
                className="history-line"
              />
            ))}
            {valid.map((sample, index) => (
              <circle
                key={index}
                cx={
                  20 + ((sample.measuredAt - lo) / Math.max(1, hi - lo)) * 960
                }
                cy={160 - sample.cpuPercent! * 1.4}
                r={3}
                className="history-dot"
              />
            ))}
          </svg>
          <div className="history-labels">
            <small>{stamp(lo)}</small>
            <small>0–100% CPU · no interpolation across gaps</small>
            <small>{stamp(hi)}</small>
          </div>
        </>
      )}
      <details className="history-data">
        <summary>View reading data ({ordered.length})</summary>
        <div className="table-scroll bounded">
          <table>
            <caption className="sr-only">
              CPU observations in chronological order. Missing values and gaps
              are not interpolated.
            </caption>
            <thead>
              <tr>
                <th scope="col">Measured at</th>
                <th scope="col">CPU</th>
                <th scope="col">Observation</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((sample, index) => (
                <tr key={`${sample.measuredAt}-${index}`}>
                  <td>{stamp(sample.measuredAt)}</td>
                  <td>
                    {sample.cpuPercent === null
                      ? "Not measured"
                      : `${sample.cpuPercent.toFixed(1)}%`}
                  </td>
                  <td>
                    {sample.cpuPercent === null
                      ? "Missing CPU value"
                      : index > 0 &&
                          sample.measuredAt - ordered[index - 1].measuredAt >
                            90000
                        ? "Gap before this reading"
                        : "Measured"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
function Jobs({
  jobs,
  hosts,
  open,
  cancel,
  canManage,
  unavailable = false,
}: {
  jobs: Job[];
  hosts: Host[];
  open: (id: string) => void;
  cancel: (id: string) => void;
  canManage: boolean;
  unavailable?: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Jobs</h2>
        <span className="muted">Latest 200 · output permission required</span>
      </div>
      {!jobs.length ? (
        <Empty>
          {unavailable ? "Job history unavailable." : "No management jobs yet."}
        </Empty>
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
function Activity({
  audit,
  unavailable = false,
}: {
  audit: Audit[];
  unavailable?: boolean;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Activity timeline</h2>
        <span className="muted">Latest 500 · retained 90 days</span>
      </div>
      {!audit.length ? (
        <Empty>
          {unavailable
            ? "Activity history unavailable."
            : "No activity in view."}
        </Empty>
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
function Access({ hosts, onVerify }: { hosts: Host[]; onVerify: () => void }) {
  const [users, setUsers] = useState<User[]>([]),
    [usersLoaded, setUsersLoaded] = useState(false),
    [usersLoading, setUsersLoading] = useState(true),
    [usersError, setUsersError] = useState<unknown>(null),
    [secret, setSecret] = useState(""),
    [createdName, setCreatedName] = useState(""),
    [createError, setCreateError] = useState<unknown>(null),
    [createNotice, setCreateNotice] = useState(""),
    [draft, setDraft] = useState(false),
    [busy, setBusy] = useState(false);
  const alive = useRef(false),
    loadVersion = useRef(0),
    createRef = useRef<HTMLDetailsElement>(null);
  useUnsavedChanges(
    draft || !!secret || busy,
    secret
      ? "new account authenticator setup (the secret is shown once)"
      : busy
        ? "account creation in progress (it can complete after leaving; authenticator setup is shown once)"
        : "new account",
  );
  async function loadUsers() {
    const version = ++loadVersion.current;
    setUsersLoading(true);
    try {
      const value = await api<User[]>("/api/users");
      if (!alive.current || version !== loadVersion.current) return;
      setUsers(value);
      setUsersLoaded(true);
      setUsersError(null);
    } catch (error) {
      if (alive.current && version === loadVersion.current)
        setUsersError(error);
    } finally {
      if (alive.current && version === loadVersion.current)
        setUsersLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void loadUsers();
    return () => {
      alive.current = false;
    };
  }, []);
  async function create(e: FormEvent<HTMLFormElement>) {
    const form = e.currentTarget,
      f = field(e);
    if (busy || secret) return;
    setBusy(true);
    setCreateError(null);
    setCreateNotice("");
    try {
      const value = await api<{ secret: string }>("/api/users", "POST", {
        name: f.get("name"),
        role: f.get("role"),
        password: f.get("password"),
      });
      if (!alive.current) return;
      setSecret(value.secret);
      setCreatedName(String(f.get("name")));
      setDraft(false);
      form.reset();
      setCreateNotice(
        "Account " +
          String(f.get("name")) +
          " created with no grants. Store its authenticator secret, then select the account above to assign access.",
      );
      await loadUsers();
    } catch (error) {
      if (alive.current) setCreateError(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">LEAST PRIVILEGE</p>
          <h1>Access & accounts</h1>
          <p className="muted">
            Roles set the ceiling. Host, group, project and action grants
            determine access. New accounts start with no grants.
          </p>
        </div>
        <button
          onClick={() => {
            const details = createRef.current;
            if (details) {
              details.open = true;
              details.scrollIntoView({ block: "start" });
              details.querySelector("input")?.focus();
            }
          }}
        >
          Create account
        </button>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Account grants</h2>
          <span className="muted">Complete set · max 100</span>
        </div>
        <div className="panel-body">
          <ErrorNotice
            error={usersError}
            onDismiss={() => setUsersError(null)}
          />
          {usersLoading && (
            <p role="status" className="muted">
              Loading accounts…
            </p>
          )}
          {!usersLoading && (!usersLoaded || !!usersError) && (
            <button type="button" onClick={() => void loadUsers()}>
              Retry accounts
            </button>
          )}
          <GrantEditor
            hosts={hosts}
            users={users.filter((user) => user.role !== "admin")}
            usersLoaded={usersLoaded}
            usersLoading={usersLoading}
            onVerify={onVerify}
          />
        </div>
      </section>
      <details ref={createRef} className="disclosure account-create">
        <summary>
          <strong>Create an account</strong>
          <span>Viewer or operator · no grants by default</span>
        </summary>
        <div className="disclosure-body">
          <ErrorNotice
            error={createError}
            onDismiss={() => setCreateError(null)}
            onVerify={onVerify}
          />
          <StatusNotice>{createNotice}</StatusNotice>
          <form
            className="form"
            aria-label="Create an account"
            onSubmit={create}
            onChange={() => setDraft(true)}
          >
            <fieldset
              className="account-fields"
              aria-label="Account details"
              disabled={busy || !!secret}
            >
              <label>
                Name
                <input name="name" autoComplete="off" required />
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
                  aria-describedby="account-password-help"
                  required
                />
                <small id="account-password-help">
                  Use at least 14 characters and no more than 72 bytes. Letters,
                  numbers and basic symbols use one byte each.
                </small>
              </label>
            </fieldset>
            <button className="primary" disabled={busy || !!secret}>
              {busy ? "Working…" : "Create account"}
            </button>
          </form>
          {secret && (
            <div className="notice">
              <p>
                Authenticator setup for {createdName}. Share this secret through
                a trusted channel. It is shown once; dismiss it before creating
                another account.
              </p>
              <code className="secret">{secret}</code>
              <button type="button" onClick={() => setSecret("")}>
                Dismiss secret
              </button>
            </div>
          )}
        </div>
      </details>
    </>
  );
}
