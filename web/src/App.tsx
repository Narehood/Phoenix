import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { JobCancellation, JobOutcome, jobAction } from "./jobs";
import {
  HostInventoryForm,
  MappingForm,
  ServiceGuidance,
  ServiceRequests,
} from "./host-controls";
import {
  NavigationProvider,
  RouteLink,
  useNavigation,
  useUnsavedChanges,
} from "./navigation";

function focusHostSection(id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  if (section instanceof HTMLDetailsElement) section.open = true;
  const target = section.querySelector<HTMLElement>("h2,summary") || section;
  target.tabIndex = -1;
  target.focus({ preventScroll: true });
  section.scrollIntoView({ block: "start" });
}

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
  host.connectivity === "unknown" ||
  host.connectivity === "never_seen" ||
  host.freshness === "stale" ||
  host.freshness === "unknown" ||
  host.resourceHealth === "warning";
type HostDetail = {
  host: Host;
  samples: Reading[];
  permissions?: string[];
  mappings: Canary["mappings"];
};
const requestNames = [
  ["diagnostic", "diagnostics"],
  ["logs.read", "service logs"],
  ["service.restart", "service restarts"],
  ["host.reboot", "host reboot"],
];
function resourceSummary(reading?: Reading | null) {
  if (!reading) return "No measurements available";
  const percentage = (value: number | null) =>
    value === null ? "Unknown" : `${value.toFixed(1)}%`;
  return (
    <>
      <span className="resource-value">
        CPU {percentage(reading.cpuPercent)}
      </span>
      {" · "}
      <span className="resource-value">
        Memory{" "}
        {percentage(
          reading.memoryTotal
            ? (100 * reading.memoryUsed) / reading.memoryTotal
            : null,
        )}
      </span>
      {" · "}
      <span className="resource-value">
        Disk{" "}
        {percentage(
          reading.diskTotal
            ? (100 * reading.diskUsed) / reading.diskTotal
            : null,
        )}
      </span>
    </>
  );
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
          {entries.map(([name]) => label(name)).join(", ")} unavailable
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
  const { route, navigate, canLeave, closeOutcome } = useNavigation();
  const jobFilterMemory = useRef<Record<string, JobFilters>>({});
  const activityFilterMemory = useRef<Record<string, ActivityFilters>>({});
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
    [detail, setDetail] = useState<HostDetail | null>(null),
    [error, setError] = useState(""),
    [sourceErrors, setSourceErrors] = useState<Record<string, string>>({}),
    [sourceLoaded, setSourceLoaded] = useState<Record<string, boolean>>({}),
    [detailError, setDetailError] = useState(""),
    [modalError, setModalError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState(""),
    [attentionOnly, setAttentionOnly] = useState(false),
    [compareFleet, setCompareFleet] = useState(false),
    [verificationUntil, setVerificationUntil] = useState(0),
    [verificationExpired, setVerificationExpired] = useState(false),
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
    mutationInFlight = useRef(false),
    refreshDetail = useRef<() => void>(() => {}),
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
      const version = (versions.current.Detail =
        (versions.current.Detail || 0) + 1);
      try {
        const d = await api<HostDetail>(`/api/hosts/${selected}`);
        if (alive && version === versions.current.Detail) {
          setDetail(d);
          setDetailError("");
        }
      } catch (e) {
        if (alive && version === versions.current.Detail) {
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
      if (alive && version === versions.current.Detail)
        timer = setTimeout(poll, 5000);
    }
    refreshDetail.current = () => {
      clearTimeout(timer);
      void poll();
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      refreshDetail.current = () => {};
    };
  }, [selected, user]);
  async function act(fn: () => Promise<void>) {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    const inDialog = modal !== null;
    setBusy(true);
    if (inDialog) setModalError("");
    else setError("");
    setNotice("");
    try {
      await fn();
      if (mounted.current) void refresh();
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
      mutationInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function job(action: string, args: object = {}) {
    if (!selected || !canRequest(action)) return;
    await act(async () => {
      const queued = await api<Job>(`/api/hosts/${selected}/jobs`, "POST", {
        action,
        args,
        confirm: action === "service.restart" ? selected : "",
      });
      if (!navigate({ view: "jobs", id: queued.id }))
        setNotice(
          `${jobAction(action)} queued for ${current?.name || selected}. Open Remote jobs to view the outcome.`,
        );
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
  const compactNavigation = (mobile = false) => (
    <label className="compact-navigation">
      Workspace section
      <select
        aria-label={mobile ? "Mobile workspace section" : "Workspace section"}
        value={view === "host" ? "fleet" : view}
        onChange={(event) => {
          if (navigate({ view: event.target.value })) {
            const menu = event.currentTarget.closest("details");
            if (menu) menu.open = false;
          }
        }}
      >
        {destinations.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
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
  const hostPermissions = !detailError
    ? selectedDetail?.permissions
    : undefined;
  const canRequest = (action: string) =>
    !!hostPermissions?.includes(action) &&
    !!current?.verified &&
    !current.revoked;
  const permittedRequests = requestNames
    .filter(([key]) => hostPermissions?.includes(key))
    .map(([, label]) => label);
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
        <p className="nav-scroll-note">↕ Scroll for more sections</p>
        <RouteLink className="brand" to={{ view: "fleet" }}>
          <img src="/phoenix.svg" width="40" height="40" alt="" />
          <span>
            Phoenix<small>INFRASTRUCTURE</small>
          </span>
        </RouteLink>
        <span className="nav-label">WORKSPACE</span>
        {compactNavigation()}
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
              <p className="nav-scroll-note">↕ Scroll for more sections</p>
              {compactNavigation(true)}
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
                  <p className="muted fleet-description">
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
                    {user.role === "admin" && hosts.length
                      ? "Summary & enrollment"
                      : "Fleet summary"}{" "}
                    <span className="muted fleet-summary-count">
                      {sourceLoaded.Hosts
                        ? `${hosts.length} hosts`
                        : sourceErrors.Hosts
                          ? "Unavailable"
                          : "Loading…"}
                    </span>
                  </>
                }
              >
                <p className="mobile-fleet-description">
                  Agent connection and reading freshness are independent of
                  Canary uptime.
                </p>
                {user.role === "admin" && !!hosts.length && (
                  <button
                    className="mobile-enroll"
                    onClick={() => {
                      setInvitation(null);
                      setModal("enroll");
                    }}
                  >
                    Enroll a host
                  </button>
                )}
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
              <section
                className={`panel fleet-panel${compareFleet ? " fleet-compare" : ""}`}
              >
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
                    title="Offline or unknown agents, stale or missing readings, and resource warnings. Canary uptime is separate."
                  >
                    Agent & resource issues (
                    {sourceLoaded.Hosts ? attentionCount : "…"})
                  </button>
                  <input
                    className="search"
                    aria-label="Search hosts"
                    placeholder="Search hosts…"
                    title="Search by name, address, tag or group"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <label className="fleet-view-control check">
                  <input
                    type="checkbox"
                    checked={compareFleet}
                    onChange={(event) => setCompareFleet(event.target.checked)}
                  />
                  Compare statuses
                  <span className="muted">Includes resource readings</span>
                </label>
                {attentionOnly && (
                  <p className="filter-context" role="status">
                    Offline or unknown agents, stale or missing readings, or
                    resource warnings. Canary uptime is separate.{" "}
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
                                  </span>
                                )}
                              </div>
                              <div className="host-metadata">
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
                              </div>
                            </td>
                            <td
                              role="cell"
                              aria-colindex={2}
                              data-label="Canary uptime"
                            >
                              <Tone
                                value={uptimeStatus(h)}
                                mobilePrefix="Canary"
                              />
                              <small>
                                {mappings(h).length} mapped monitor
                                {mappings(h).length === 1 ? "" : "s"}
                              </small>
                            </td>
                            <td
                              role="cell"
                              aria-colindex={3}
                              data-label="Agent connection"
                            >
                              <Tone
                                value={h.connectivity}
                                mobilePrefix="Agent"
                              />
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
                              <span className="comparison-resource-summary">
                                {h.latest &&
                                  h.freshness !== "fresh" &&
                                  "Last known · "}
                                {resourceSummary(h.latest)}
                              </span>
                              <ResponsiveDetails
                                className="resource-details"
                                label={
                                  <>
                                    <span className="resource-disclosure-label">
                                      {h.latest &&
                                        h.freshness !== "fresh" &&
                                        "Last known · "}
                                      {resourceSummary(h.latest)}
                                    </span>
                                    <span className="resource-expanded-label">
                                      Resource details
                                    </span>
                                    <span className="resource-disclosure-action">
                                      <span className="resource-closed-action">
                                        Details
                                      </span>
                                      <span className="resource-open-action">
                                        Hide
                                      </span>
                                    </span>
                                  </>
                                }
                              >
                                <div className="mobile-host-evidence">
                                  <p>
                                    {h.osVersion || "Awaiting enrollment"} ·{" "}
                                    {h.addresses.join(", ") || "No address"}
                                  </p>
                                  <p>
                                    Groups: {h.groups.join(", ") || "None"} ·{" "}
                                    {mappings(h).length} mapped monitor
                                    {mappings(h).length === 1 ? "" : "s"}
                                  </p>
                                  <p>
                                    Agent contact <Time value={h.lastContact} />
                                  </p>
                                </div>
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
                <div className="page-heading host-page-heading">
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
                          disabled={busy || !canRequest("diagnostic")}
                          title={
                            !canRequest("diagnostic")
                              ? "Requires diagnostic permission and a verified, non-revoked agent"
                              : undefined
                          }
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
                            disabled={!canRequest("host.reboot")}
                            title={
                              !canRequest("host.reboot")
                                ? "Requires host reboot permission and a verified, non-revoked agent"
                                : undefined
                            }
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
                {user.role !== "viewer" &&
                  (user.role === "operator" ||
                    permittedRequests.length < requestNames.length) && (
                    <p className="host-permission-context">
                      {!hostPermissions
                        ? "Action permissions unavailable. Requests stay disabled until host details can be read."
                        : `Your permitted requests: ${permittedRequests.join(", ") || "none"}. Each request is checked again when submitted.`}
                    </p>
                  )}
                <nav className="host-section-links" aria-label="Host sections">
                  <select
                    aria-label="Jump to host section"
                    value=""
                    onChange={(event) => focusHostSection(event.target.value)}
                  >
                    <option value="">Jump to host section…</option>
                    <option value="host-overview">Overview</option>
                    {reading && (
                      <option value="host-history">CPU history</option>
                    )}
                    <option value="host-services">Services</option>
                    <option value="host-processes">Processes</option>
                    <option value="host-configuration">Configuration</option>
                    <option value="host-jobs">Jobs</option>
                  </select>
                  {[
                    ["Overview", "host-overview"],
                    ["CPU history", "host-history"],
                    ["Services", "host-services"],
                    ["Processes", "host-processes"],
                    ["Configuration", "host-configuration"],
                    ["Jobs", "host-jobs"],
                  ]
                    .filter(([, id]) => id !== "host-history" || reading)
                    .map(([label, id]) => (
                      <button
                        key={id}
                        type="button"
                        className="text-link"
                        onClick={() => focusHostSection(id)}
                      >
                        {label}
                      </button>
                    ))}
                </nav>
                <div
                  className="metrics host-status"
                  id="host-overview"
                  tabIndex={-1}
                >
                  <Metric
                    label="Canary uptime"
                    value={<Tone value={uptimeStatus(current)} />}
                    detail="Independent monitoring"
                  />
                  <Metric
                    label="Agent connection"
                    value={<Tone value={current.connectivity} />}
                    detail={
                      <>
                        Contact <Time value={current.lastContact} />
                      </>
                    }
                  />
                  <Metric
                    label="Reading freshness"
                    value={<Tone value={current.freshness} />}
                    detail={
                      <>
                        Collected <Time value={reading?.collectedAt || 0} />
                      </>
                    }
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
                            ? "Not measured"
                            : `${reading.cpuPercent.toFixed(1)}%`
                        }
                        detail={
                          <>
                            Measured <Time value={reading.measuredAt} />
                          </>
                        }
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
                    <section className="panel cpu-history" id="host-history">
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
                <div className="host-observations">
                  <section className="panel" id="host-services">
                    <div className="panel-heading">
                      <h2>systemd services</h2>
                      <span className="muted">
                        {retainedReading
                          ? "Last known service snapshot"
                          : "Service state snapshot"}
                      </span>
                    </div>
                    {user.role !== "viewer" && (
                      <ServiceGuidance host={current} />
                    )}
                    {!reading?.services.length ? (
                      <Empty>No service readings available.</Empty>
                    ) : (
                      <div className="table-scroll bounded">
                        <table
                          role="table"
                          aria-colcount={3}
                          className="service-table responsive-table"
                        >
                          <caption className="sr-only">
                            Observed systemd service states and guarded agent
                            requests
                          </caption>
                          <thead role="rowgroup">
                            <tr role="row">
                              <th
                                role="columnheader"
                                aria-colindex={1}
                                scope="col"
                              >
                                Service
                              </th>
                              <th
                                role="columnheader"
                                aria-colindex={2}
                                scope="col"
                              >
                                {retainedReading ? "Last known state" : "State"}
                              </th>
                              <th
                                role="columnheader"
                                aria-colindex={3}
                                scope="col"
                              >
                                Agent requests
                              </th>
                            </tr>
                          </thead>
                          <tbody role="rowgroup">
                            {reading.services.map((s) => (
                              <tr role="row" key={s.name}>
                                <td
                                  role="cell"
                                  aria-colindex={1}
                                  data-label="Service"
                                >
                                  <code>{s.name}</code>
                                  <small>
                                    {s.load} / {s.sub}
                                  </small>
                                </td>
                                <td
                                  role="cell"
                                  aria-colindex={2}
                                  data-label={
                                    retainedReading
                                      ? "Last known state"
                                      : "State"
                                  }
                                >
                                  {s.active}
                                </td>
                                <td
                                  role="cell"
                                  aria-colindex={3}
                                  data-label="Agent requests"
                                >
                                  {user.role !== "viewer" ? (
                                    <ServiceRequests
                                      key={current.id + "/" + s.name}
                                      host={current}
                                      service={s.name}
                                      permissions={hostPermissions}
                                      onQueued={() => void refresh()}
                                      onVerify={() => setModal("auth")}
                                    />
                                  ) : (
                                    <small>Read-only</small>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {retainedReading && (
                      <p className="snapshot-action-note">
                        Service states are last known and may have changed.
                      </p>
                    )}
                  </section>
                  <section className="panel" id="host-processes">
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
                <details
                  className="panel disclosure host-configuration"
                  id="host-configuration"
                  key={current.id}
                >
                  <summary>
                    Host configuration
                    <span>Monitor mappings and inventory</span>
                  </summary>
                  <div className="disclosure-body">
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Canary monitor mapping</h2>
                        <span className="muted">Source + monitor identity</span>
                      </div>
                      <div className="panel-body">
                        {user.role === "admin" ? (
                          <MappingForm
                            key={current.id}
                            host={current}
                            canary={canary}
                            savedMappings={detail?.mappings || []}
                            loaded={
                              !!sourceLoaded.Canary &&
                              detail?.mappings !== undefined
                            }
                            unavailable={!!sourceErrors.Canary}
                            onSaved={() => {
                              refreshDetail.current();
                              void refresh();
                            }}
                            onVerify={() => setModal("auth")}
                          />
                        ) : (
                          mappings(current).map((m) => (
                            <p
                              key={`${m.mapping.sourceId}/${m.mapping.monitorId}`}
                            >
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
                          <HostInventoryForm
                            key={current.id}
                            host={current}
                            canEdit={!!hostPermissions?.includes("host.manage")}
                            onSaved={() => {
                              refreshDetail.current();
                              void refresh();
                            }}
                            onVerify={() => setModal("auth")}
                          />
                        </div>
                      </section>
                    )}
                  </div>
                </details>
                <Jobs
                  key={`jobs:${current.id}`}
                  memory={jobFilterMemory.current}
                  memoryKey={`host:${current.id}`}
                  loaded={!!sourceLoaded.Jobs}
                  unavailable={!!sourceErrors.Jobs}
                  jobs={hostJobs}
                  hosts={hosts}
                  onChanged={() => void refresh()}
                  id="host-jobs"
                />
                <Activity
                  key={`activity:${current.id}`}
                  memory={activityFilterMemory.current}
                  memoryKey={`host:${current.id}`}
                  hosts={hosts}
                  loaded={!!sourceLoaded.Activity}
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
                memory={jobFilterMemory.current}
                memoryKey="all"
                loaded={!!sourceLoaded.Jobs}
                unavailable={!!sourceErrors.Jobs}
                jobs={jobs}
                hosts={hosts}
                onChanged={() => void refresh()}
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
              <Activity
                memory={activityFilterMemory.current}
                memoryKey="all"
                hosts={hosts}
                loaded={!!sourceLoaded.Activity}
                audit={audit}
                unavailable={!!sourceErrors.Activity}
              />
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
                      const queued = await api<Job>(
                        `/api/hosts/${selected}/jobs`,
                        "POST",
                        {
                          action: "host.reboot",
                          args: {},
                          confirm: selected,
                        },
                      );
                      setModal(null);
                      if (!navigate({ view: "jobs", id: queued.id }))
                        setNotice(
                          `Reboot queued for ${current?.name || selected}. Open Remote jobs to check acceptance and boot observation separately.`,
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
                  Current code from your authenticator
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
      {view === "jobs" && route.id && (
        <JobOutcome key={route.id} id={route.id} onClose={closeOutcome} />
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
        <Empty>No CPU history samples available.</Empty>
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
            Latest measured {valid.at(-1)!.cpuPercent!.toFixed(1)}%
            {valid.length > 1 && (
              <>
                {" "}
                · range{" "}
                {Math.min(...valid.map((s) => s.cpuPercent!)).toFixed(1)}–
                {Math.max(...valid.map((s) => s.cpuPercent!)).toFixed(1)}%
              </>
            )}
            {" · "}
            {ordered.length === 1
              ? "1 reading"
              : `${valid.length} measured of ${ordered.length} readings`}
            .
          </>
        ) : (
          "No measured CPU values in this window."
        )}
        {valid.length < 2 && " Two measurements are needed to draw history."}
        {ordered.length > 1 && " Gaps remain unknown."}
      </p>
      {valid.length >= 2 && (
        <>
          <div className="history-chart">
            <div className="history-axis" aria-hidden="true">
              <span>100%</span>
              <span>50%</span>
              <span>0%</span>
            </div>
            <div className="history-plot">
              <svg
                viewBox="0 0 1000 180"
                preserveAspectRatio="none"
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
              </svg>
              {valid.map((sample, index) => (
                <span
                  key={index}
                  className="history-point"
                  aria-hidden="true"
                  style={{
                    left: `${(20 + ((sample.measuredAt - lo) / Math.max(1, hi - lo)) * 960) / 10}%`,
                    top: `${(160 - sample.cpuPercent! * 1.4) / 1.8}%`,
                  }}
                />
              ))}
            </div>
          </div>
          <div className="history-ticks" aria-hidden="true">
            <time dateTime={new Date(lo).toISOString()}>{stamp(lo)}</time>
            <time dateTime={new Date((lo + hi) / 2).toISOString()}>
              {new Date((lo + hi) / 2).toLocaleTimeString()}
            </time>
            <time dateTime={new Date(hi).toISOString()}>{stamp(hi)}</time>
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
                <th scope="col">Notes</th>
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
type JobFilters = { query: string; state: string; action: string };
function Jobs({
  memory,
  memoryKey,
  jobs,
  hosts,
  onChanged,
  id,
  loaded,
  unavailable = false,
}: {
  memory: Record<string, JobFilters>;
  memoryKey: string;
  jobs: Job[];
  hosts: Host[];
  onChanged: () => void;
  id?: string;
  loaded: boolean;
  unavailable?: boolean;
}) {
  const [filters, setFilters] = useState<JobFilters>(
    () => memory[memoryKey] || { query: "", state: "", action: "" },
  );
  const { query, state, action } = filters;
  const changeFilters = (patch: Partial<JobFilters>) => {
    const next = { ...filters, ...patch };
    memory[memoryKey] = next;
    setFilters(next);
  };
  const setQuery = (query: string) => changeFilters({ query });
  const setState = (state: string) => changeFilters({ state });
  const setAction = (action: string) => changeFilters({ action });
  const boundsId = useId();
  const hostName = (job: Job) =>
    hosts.find((host) => host.id === job.hostId)?.name ||
    job.hostName ||
    job.hostId;
  const filtered = jobs.filter(
    (job) =>
      (!state || job.state === state) &&
      (!action || job.action === action) &&
      `${job.id} ${hostName(job)} ${job.hostId} ${jobAction(job.action)} ${job.action} ${job.args.service || ""} ${job.args.diagnostic || ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const clearFilters = () => {
    changeFilters({ query: "", state: "", action: "" });
  };
  return (
    <section className="panel jobs-panel" id={id}>
      <div className="panel-heading">
        <h2>Jobs</h2>
        <span
          className="muted job-filter-count"
          id={boundsId}
          role="status"
          title="Command output requires a separate permission."
        >
          {!!jobs.length && (
            <>
              {filtered.length} of {jobs.length} ·{" "}
            </>
          )}
          Within latest 200
        </span>
      </div>
      <form
        className="job-filters"
        role="search"
        aria-label="Filter jobs"
        aria-describedby={boundsId}
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Search jobs
          <input
            type="search"
            name="jobSearch"
            placeholder="Host, target or job ID…"
            value={query}
            disabled={!loaded || !jobs.length}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <ResponsiveDetails
          className="job-filter-options"
          label={`State & action${state || action ? " · filtered" : ""}`}
        >
          <div className="job-filter-fields">
            <label>
              State
              <select
                name="jobState"
                value={state}
                disabled={!loaded || !jobs.length}
                onChange={(event) => setState(event.target.value)}
              >
                <option value="">All states</option>
                {[...new Set([state, ...jobs.map((job) => job.state)])]
                  .filter(Boolean)
                  .sort()
                  .map((value) => (
                    <option key={value} value={value}>
                      {value.charAt(0).toUpperCase() +
                        value.slice(1).replaceAll("_", " ")}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Action
              <select
                name="jobAction"
                value={action}
                disabled={!loaded || !jobs.length}
                onChange={(event) => setAction(event.target.value)}
              >
                <option value="">All actions</option>
                {[...new Set([action, ...jobs.map((job) => job.action)])]
                  .filter(Boolean)
                  .sort()
                  .map((value) => (
                    <option key={value} value={value}>
                      {jobAction(value)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </ResponsiveDetails>
        {(query || state || action) && (
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </form>
      {unavailable && !!jobs.length && (
        <p className="job-history-warning" role="status">
          Retained history; source unavailable.
        </p>
      )}
      {!jobs.length ? (
        <Empty>
          {unavailable
            ? "Job history unavailable."
            : !loaded
              ? "Loading job history…"
              : "No jobs in this history window."}
        </Empty>
      ) : !filtered.length ? (
        <Empty>
          No matching jobs within the latest 200.{" "}
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        </Empty>
      ) : (
        <div className="table-scroll">
          <table
            className="jobs-table responsive-table"
            role="table"
            aria-colcount={5}
          >
            <caption className="sr-only">
              Remote job targets, request states and permitted actions
            </caption>
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col" aria-colindex={1}>
                  Action
                </th>
                <th role="columnheader" scope="col" aria-colindex={2}>
                  Host
                </th>
                <th role="columnheader" scope="col" aria-colindex={3}>
                  State
                </th>
                <th role="columnheader" scope="col" aria-colindex={4}>
                  Created
                </th>
                <th role="columnheader" scope="col" aria-colindex={5}>
                  Outcome
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {filtered.map((j) => (
                <tr role="row" key={j.id}>
                  <td role="cell" aria-colindex={1} data-label="Action">
                    <strong>{jobAction(j.action)}</strong>
                    {(j.args.service || j.args.diagnostic) && (
                      <small>{j.args.service || j.args.diagnostic}</small>
                    )}
                  </td>
                  <td role="cell" aria-colindex={2} data-label="Host">
                    {hosts.some((host) => host.id === j.hostId) ? (
                      <RouteLink to={{ view: "host", id: j.hostId }}>
                        {hostName(j)}
                      </RouteLink>
                    ) : (
                      hostName(j)
                    )}
                  </td>
                  <td role="cell" aria-colindex={3} data-label="State">
                    <Tone value={j.state} />
                    {j.cancelRequested && j.state !== "cancelled" && (
                      <small>Cancellation requested</small>
                    )}
                  </td>
                  <td role="cell" aria-colindex={4} data-label="Created">
                    <Time value={j.createdAt} />
                  </td>
                  <td role="cell" aria-colindex={5} data-label="Outcome">
                    <RouteLink
                      to={{ view: "jobs", id: j.id }}
                      aria-label={`View outcome for ${jobAction(j.action)}${j.args.service || j.args.diagnostic ? ` (${j.args.service || j.args.diagnostic})` : ""} on ${hostName(j)}, created ${stamp(j.createdAt)}`}
                    >
                      View outcome →
                    </RouteLink>
                    {j.action === "host.reboot" && (
                      <small>
                        New boot:{" "}
                        {j.rebootObserved ? "observed" : "not observed"}
                      </small>
                    )}
                    <JobCancellation
                      job={j}
                      targetLabel={`${jobAction(j.action)}${j.args.service || j.args.diagnostic ? ` (${j.args.service || j.args.diagnostic})` : ""} on ${hostName(j)}, created ${stamp(j.createdAt)}`}
                      unavailable={unavailable}
                      onChanged={onChanged}
                    />
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
function activityAction(action: string) {
  return (
    (
      {
        setup: "Workspace setup",
        "sessions.revoke": "Sessions revoked",
        "account.create": "Account created",
        "account.disable": "Account disabled",
        "grants.replace": "Account permissions replaced",
        "canary.mapping": "Uptime mappings updated",
        "inventory.update": "Host details updated",
        "invitation.create": "Enrollment invitation issued",
        "agent.enroll": "Agent enrolled",
        "agent.approve": "Agent approved",
        "agent.revoke": "Agent revoked",
        "certificate.rotate": "Agent certificate rotated",
        "receipt.unmatched": "Unmatched agent receipt",
        "admin.recover": "Administrator recovery",
      } as Record<string, string>
    )[action] || jobAction(action)
  );
}
type ActivityFilters = { query: string; action: string };
function Activity({
  memory,
  memoryKey,
  audit,
  hosts,
  loaded,
  unavailable = false,
}: {
  memory: Record<string, ActivityFilters>;
  memoryKey: string;
  audit: Audit[];
  hosts: Host[];
  loaded: boolean;
  unavailable?: boolean;
}) {
  const [filters, setFilters] = useState<ActivityFilters>(
    () => memory[memoryKey] || { query: "", action: "" },
  );
  const { query, action } = filters;
  const changeFilters = (patch: Partial<ActivityFilters>) => {
    const next = { ...filters, ...patch };
    memory[memoryKey] = next;
    setFilters(next);
  };
  const setQuery = (query: string) => changeFilters({ query });
  const setAction = (action: string) => changeFilters({ action });
  const boundsId = useId();
  const filtered = audit.filter(
    (event) =>
      (!action || event.action === action) &&
      `${activityAction(event.action)} ${event.action} ${event.actor} ${event.hostId} ${hosts.find((host) => host.id === event.hostId)?.name || ""} ${event.jobId} ${event.state.replaceAll("_", " ")}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const clearFilters = () => changeFilters({ query: "", action: "" });
  return (
    <section className="panel activity-panel">
      <div className="panel-heading">
        <h2>Activity timeline</h2>
        <span className="muted" id={boundsId} role="status">
          {!!audit.length && `${filtered.length} of ${audit.length} · `}
          Within latest 500 · retained 90 days
        </span>
      </div>
      <div className="activity-filter-tools">
        <ResponsiveDetails
          className="activity-filter-disclosure"
          label={`Filter activity${query || action ? " · filters applied" : ""}`}
        >
          <form
            className="activity-filters"
            role="search"
            aria-label="Filter activity"
            aria-describedby={boundsId}
            onSubmit={(event) => event.preventDefault()}
          >
            <label>
              Search activity
              <input
                type="search"
                name="activitySearch"
                placeholder="Action, actor, host or job ID…"
                value={query}
                disabled={!loaded || !audit.length}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              Action
              <select
                name="activityAction"
                value={action}
                disabled={!loaded || !audit.length}
                onChange={(event) => setAction(event.target.value)}
              >
                <option value="">All actions</option>
                {[...new Set([action, ...audit.map((event) => event.action)])]
                  .filter(Boolean)
                  .sort()
                  .map((value) => (
                    <option key={value} value={value}>
                      {activityAction(value)}
                    </option>
                  ))}
              </select>
            </label>
          </form>
        </ResponsiveDetails>
        {(query || action) && (
          <div className="activity-applied">
            <span>
              {query && (
                <>
                  Search: <strong>{query}</strong>
                  {action && " · "}
                </>
              )}
              {action && (
                <>
                  Action: <strong>{activityAction(action)}</strong>
                </>
              )}
            </span>
            <button type="button" onClick={clearFilters}>
              Clear activity filters
            </button>
          </div>
        )}
      </div>
      {!audit.length ? (
        <Empty>
          {unavailable
            ? "Activity history unavailable."
            : !loaded
              ? "Loading activity history…"
              : "No activity in view."}
        </Empty>
      ) : !filtered.length ? (
        <Empty>
          No matching events within the latest 500.{" "}
          <button type="button" onClick={clearFilters}>
            Clear activity filters
          </button>
        </Empty>
      ) : (
        <ol className="timeline">
          {filtered.map((a) => {
            const host = hosts.find((host) => host.id === a.hostId);
            const label = activityAction(a.action);
            return (
              <li key={a.id}>
                <span className="timeline-dot" />
                <div className="activity-event">
                  <strong>{label}</strong> <Tone value={a.state} />
                  <div className="activity-context">
                    <Time value={a.at} />
                    {host ? (
                      <RouteLink to={{ view: "host", id: host.id }}>
                        {host.name}
                      </RouteLink>
                    ) : a.hostId ? (
                      <span>Host outside loaded inventory</span>
                    ) : null}
                    {host && a.jobId && (
                      <RouteLink
                        to={{ view: "jobs", id: a.jobId }}
                        aria-label={`View job outcome for ${label} on ${host.name}`}
                      >
                        Outcome →
                      </RouteLink>
                    )}
                  </div>
                  <details className="activity-identifiers">
                    <summary>
                      Actor:{" "}
                      {a.actor.length > 18
                        ? a.actor.slice(0, 12) + "…"
                        : a.actor || "Not recorded"}{" "}
                      · identifiers
                    </summary>
                    <dl className="job-identity-fields">
                      <div>
                        <dt>Actor</dt>
                        <dd>
                          <code>{a.actor || "Not recorded"}</code>
                        </dd>
                      </div>
                      {a.hostId && (
                        <div>
                          <dt>Host ID</dt>
                          <dd>
                            <code>{a.hostId}</code>
                          </dd>
                        </div>
                      )}
                      {a.jobId && (
                        <div>
                          <dt>Job ID</dt>
                          <dd>
                            <code>{a.jobId}</code>
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt>Action key</dt>
                        <dd>
                          <code>{a.action}</code>
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
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
