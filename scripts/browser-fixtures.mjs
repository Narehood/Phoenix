// Linux CI only. Exercise the built dashboard with fresh, bounded API fixtures.
// No Phoenix server, retained identity, real host or external service is used.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { captureUI } from "./ui-scenes.mjs";

assert.equal(process.platform, "linux", "Browser fixtures require Linux CI");
assert.ok(process.env.PHOENIX_OUTPUT, "Run through scripts/validate.py");
const scratch = process.env.PHOENIX_OUTPUT;
const visual = process.argv.includes("--visual");
const web = join(scratch, "web");
const evidence = resolve(visual ? ".validation/ui-evidence" : ".validation/browser-evidence");
mkdirSync(web);
mkdirSync(evidence, { recursive: true });
const container = execFileSync("docker", ["create", visual ? "phoenix:web-ui" : "phoenix:ci"], { encoding: "utf8", timeout: 10000 }).trim();
assert.match(container, /^[a-f0-9]{64}$/);
try {
  execFileSync("docker", ["cp", `${container}:${visual ? "/src/web/dist" : "/usr/share/phoenix/web"}/.`, web], { timeout: 10000 });
} finally {
  execFileSync("docker", ["rm", container], { timeout: 10000 });
}

function installFixture(visualCapture = false) {
  // Screenshot scenes exercise presentation, not polling cadence. Accelerate
  // only five-second refresh delays so synthetic state changes render promptly.
  // The interactive regression suite keeps the production timer values.
  if (visualCapture) {
    const fixtureSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) =>
      fixtureSetTimeout(callback, delay === 5000 ? 1000 : delay, ...args);
  }
  const now = Date.now();
  const user = (role) => ({ id: `${role}-fixture`, name: `${role}-fixture`, role, active: true });
  const reading = {
    measuredAt: now, collectedAt: now, cpuPercent: 12, memoryUsed: 256 * 1024 ** 2,
    memoryTotal: 1024 ** 3, diskUsed: 1024 ** 3, diskTotal: 8 * 1024 ** 3,
    networkRx: 4096, networkTx: 2048, networkRxBps: 128, networkTxBps: 64,
    uptimeSeconds: 3600, bootId: "fixture-boot", services: [{name: "fixture.service", load: "loaded", active: "active", sub: "running"}], collectionErrors: [],
    processes: [{ pid: 123, name: "ADMIN-ONLY-PROCESS", memoryBytes: 4096 }],
  };
  const host = (id, name) => ({
    id, name, os: "linux", osVersion: "Debian fixture", addresses: ["192.0.2.1"],
    tags: [], groups: [], connectionMethod: "outbound-agent", agentVersion: "fixture",
    lastContact: now, revoked: false, verified: true, certificateFingerprint: "fixture-public-fingerprint",
    generation: 1, bootId: "fixture-boot", connectivity: "connected", freshness: "fresh",
    resourceHealth: "normal", latest: { ...reading, processes: id === "private-host" ? reading.processes : [] },
  });
  const privateHost = host("private-host", "ADMIN-ONLY-HOST");
  const viewerHost = host("viewer-host", "Viewer fixture host");
  const fixtureHosts = [privateHost, viewerHost];
  const inventoryRevision = h => JSON.stringify([h.name, h.tags, h.groups]);
  const emptyCanary = { sources: [], mappings: [], now };
  const canary = {
    now, mappings: [{ hostId: privateHost.id, sourceId: "fixture-source", monitorId: "unobserved" }],
    sources: [{ id: "fixture-source", node: { id: "fixture-node", name: "Fixture node" },
      revision: "fixture", collectedAt: now, measuredAt: now, freshness: "fresh", error: "",
      maintenance: [], monitors: [{ monitor: { id: "unobserved", name: "Unobserved fixture monitor", intervalMs: 30000, nodeIds: [] },
        state: "unknown", observations: null, maintenanceIds: [], unknownNodes: 1, configConflict: false }] }],
  };
  const control = window.fixture = { role: "admin", hosts: fixtureHosts, offline: false, htmlFailure: false, logoutFailure: 0, grantWrites: 0, holdHosts: false, releaseHosts: null,
    // Project, GitHub and grant stores start empty: nothing is preseeded in the product.
    usersFail: true, recent: true, authFailure: 0, githubFail: false, syncStatus: 429, projects: {}, events: {}, githubViews: {}, githubPuts: [], failSources: new Set(), failWrites: new Set(), createdUsers: [], jobs: [], audit: [], canary, hostPermissions: null,
    grantStore: {
      "operator-fixture": [{ scopeType: "host", scope: "viewer-host", action: "host.read" }, { scopeType: "project", scope: "fixture-project", action: "project.read" }],
      "viewer-fixture": [{ scopeType: "host", scope: "viewer-host", action: "host.read" }],
    },
    lastGrantPut: null, shared: ["fixture-project"], requests: [], hold: new Set(new URLSearchParams(location.search).has("hold") ? ["/api/hosts", "/api/canary", "/api/jobs", "/api/audit"] : []), holds: {}, samples: [reading] };
  const refreshEvidence = () => {
    for (const h of fixtureHosts) {
      h.inventoryRevision = inventoryRevision(h);
      if (h.connectivity === "connected") h.lastContact = Date.now();
      if (h.freshness === "fresh" && h.latest) {
        h.latest.measuredAt = Date.now(); h.latest.collectedAt = Date.now();
      }
    }
    for (const source of canary.sources) if (source.freshness === "fresh") {
      source.collectedAt = Date.now(); source.measuredAt = Date.now();
    }
  };
  control.populateHistory = () => {
    const at = Date.now();
    control.samples = [12, 64, null, 21].map((cpuPercent, i) => ({...reading, cpuPercent, measuredAt: at - (i > 1 ? i + 3 : i) * 30000, collectedAt: at - (i > 1 ? i + 3 : i) * 30000}));
  };
  control.longFleet = () => {
    for (let i = fixtureHosts.length; i < 12; i++) {
      const h = host(`extra-${i}`, `worker-${String(i + 1).padStart(2, "0")}`);
      h.groups = ["Production"]; fixtureHosts.push(h);
    }
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const recentRequired = () => json({ error: "recent password and MFA required" }, 403);
  const hostPermissions = () => control.hostPermissions ?? (control.role === "admin" ? ["host.read", "host.manage", "diagnostic", "logs.read", "service.restart", "host.reboot", "jobs.cancel", "jobs.output"] : ["host.read"]);
  const jobView = job => ({...job, canCancel: hostPermissions().includes("jobs.cancel") && !job.cancelRequested && ["queued","dispatched"].includes(job.state)});
  const allModules = ["documentation", "dependencies", "content", "releases", "operations"];
  const permissionsFor = () => control.role === "admin" ? ["project.read", "project.manage", "github.read", "github.sync"] : ["project.read"];
  const visible = (id) => !!control.projects[id] && (control.role === "admin" || control.shared.includes(id));
  const record = (id, action) => (control.events[id] ||= []).unshift({ at: Date.now(), actor: `${control.role}-fixture`, action, revision: control.projects[id].revision });
  const notConfigured = { configured: false, repository: "", enabled: false, revision: 0, state: "not_configured", freshness: "unknown", error: "", lastAttemptAt: 0, collectedAt: 0, nextAttemptAt: 0, snapshot: null };
  const iso = new Date(now).toISOString();
  const snapshot = (repo) => ({
    repository: { fullName: repo, url: `https://github.com/${repo}`, private: true, archived: false, defaultBranch: "main", pushedAt: iso },
    pulls: { state: "ok", truncated: false, items: [
      { number: 7, title: "Bump fixture-lib from 1.0.0 to 1.0.1", url: `https://github.com/${repo}/pull/7`, author: "dependabot[bot]", draft: false, updatedAt: iso, dependencyUpdate: true, updateKind: "security_or_version_unclassified", mergeable: "mergeable", reviewState: "approval_observed", checks: "passing_observed" },
      { number: 8, title: "Fixture feature change", url: `https://github.com/${repo}/pull/8`, author: "fixture-dev", draft: false, updatedAt: iso, dependencyUpdate: false, updateKind: "", mergeable: "unknown", reviewState: "no_current_approval", checks: "pending" },
    ] },
    defaultBranchCI: { state: "ok", truncated: false, items: [{ name: "CI", url: `https://github.com/${repo}/actions/runs/1`, status: "completed", conclusion: "success", sha: "a".repeat(40) }] },
    alerts: { state: "ok", truncated: false, items: [] },
    codeScanning: "unsupported", secretScanning: "unsupported", dependencyCoverage: "update_prs_and_dependabot_alerts_only",
  });
  control.freshView = (repo) => ({ configured: true, repository: repo, enabled: true, revision: 1, state: "fresh", freshness: "fresh", error: "", lastAttemptAt: Date.now(), collectedAt: Date.now(), nextAttemptAt: Date.now() - 1000, snapshot: snapshot(repo) });
  control.retainedView = (repo) => {
    const view = control.freshView(repo);
    view.state = "rate_limited"; view.freshness = "stale"; view.error = "rate_limited"; view.collectedAt = Date.now() - 3600000;
    view.snapshot.defaultBranchCI = { state: "permission_denied", truncated: false, items: [] };
    view.snapshot.alerts = { state: "ok", truncated: true, items: [{ number: 3, package: "fixture-lib", ecosystem: "npm", severity: "high", summary: "Fixture advisory", fixedIn: "1.0.1", url: `https://github.com/${repo}/security/dependabot/3` }] };
    return view;
  };
  control.seedProject = (id, name, modules = []) => {
    control.projects[id] = { id, name, description: "", modules, archived: false, revision: 1, createdAt: now, updatedAt: now };
    record(id, "project.create");
  };
  control.visualScene = () => {
    privateHost.name = "edge-01";
    privateHost.osVersion = "Debian 13";
    privateHost.groups = ["Production"];
    viewerHost.name = "worker-01";
    viewerHost.osVersion = "Debian 13";
    viewerHost.groups = ["Production"];
    const stale = host("backup-host", "backup-01");
    stale.connectivity = "offline"; stale.freshness = "stale"; stale.resourceHealth = "unknown";
    stale.lastContact -= 900000; stale.latest.measuredAt -= 900000;
    stale.latest.collectedAt -= 900000; stale.groups = ["Recovery"];
    fixtureHosts.push(stale);
    reading.processes = [{ pid: 812, name: "phoenix", memoryBytes: 62 * 1024 ** 2 }, { pid: 230, name: "systemd-journald", memoryBytes: 18 * 1024 ** 2 }];
    reading.services = [{ name: "phoenix-acceptance.service", load: "loaded", active: "active", sub: "running" }];
    Object.assign(privateHost.latest, reading);
    control.usersFail = false;
    control.seedProject("website", "Website", ["dependencies"]);
    control.projects.website.description = "Public website and customer documentation.";
    control.events.website[0].actor = "fixture-project-actor-full-identifier-123456";
    control.githubViews.website = control.freshView("example/website");
    control.seedProject("platform", "Platform API", ["dependencies"]);
    control.projects.platform.description = "Internal services and shared infrastructure.";
    control.seedProject("legacy", "Legacy dashboard", []);
    control.projects.legacy.archived = true;
    control.grantStore["operator-fixture"] = [{scopeType: "host", scope: "viewer-host", action: "host.read"}, {scopeType: "project", scope: "website", action: "project.read"}];
  };
  control.externalEdit = (id) => {
    const p = control.projects[id];
    Object.assign(p, { description: "Changed elsewhere", revision: p.revision + 1, updatedAt: Date.now() });
    record(id, "project.update");
  };
  function projectRoute(method, path, body) {
    const m = path.match(/^\/api\/projects\/([^/]+)(\/capabilities|\/audit|\/github|\/github\/sync)?$/);
    const id = m && decodeURIComponent(m[1]), sub = m?.[2] || "";
    if (!m || !visible(id)) return json({ error: "project not found" }, 404);
    const p = control.projects[id], perms = permissionsFor();
    if (!sub && method === "GET") return json(p);
    if (!sub && method === "PUT") {
      if (!control.recent) return recentRequired();
      if (!perms.includes("project.manage")) return json({ error: "project management forbidden" }, 403);
      if (body.revision !== p.revision) return json({ error: "project changed; reload before saving" }, 409);
      Object.assign(p, { name: body.name, description: body.description, modules: body.modules || [], archived: body.archived, revision: p.revision + 1, updatedAt: Date.now() });
      record(id, "project.update");
      return json(p);
    }
    if (sub === "/capabilities") return json({ contractVersion: 1, projectId: id, revision: p.revision, permissions: perms, modules: allModules.map((module) => {
      const enabled = p.modules.includes(module);
      let state = enabled ? "unsupported" : "disabled", reason = enabled ? "connector_not_implemented" : "module_disabled";
      if (enabled && module === "dependencies") {
        const view = control.githubViews[id];
        [state, reason] = !perms.includes("github.read") ? ["permission_denied", "github_read_required"] : view ? [view.state, "github_read_only"] : ["not_configured", "github_not_configured"];
      }
      if (p.archived) [state, reason] = ["disabled", "project_archived"];
      return { id: module, enabled, state, reason, actions: [] };
    }) });
    if (sub === "/audit") return json({ events: control.events[id] || [] });
    if (!perms.includes("github.read")) return json({ error: "GitHub access forbidden" }, 403);
    if (sub === "/github" && method === "GET") {
      if (control.githubFail) throw new TypeError("Fixture GitHub view unavailable");
      return json(control.githubViews[id] || notConfigured);
    }
    if (sub === "/github" && method === "PUT") {
      if (control.role !== "admin") return json({ error: "administrator required" }, 403);
      if (!control.recent) return recentRequired();
      const current = control.githubViews[id] || notConfigured;
      if (body.revision !== current.revision) return json({ error: "GitHub configuration changed; reload before saving" }, 409);
      control.githubPuts.push({ repository: body.repository, enabled: body.enabled, revision: body.revision, tokenLength: body.token.length });
      control.githubViews[id] = { ...notConfigured, configured: true, repository: body.repository, enabled: body.enabled, revision: current.revision + 1, state: "pending" };
      record(id, "github.configure");
      return json({ configured: true, revision: current.revision + 1 });
    }
    if (sub === "/github/sync" && method === "POST") return control.syncStatus === 202 ? json({ scheduled: true }, 202) : json({ error: "GitHub refresh is cooling down; check nextAttemptAt" }, 429);
    return json({ error: "unexpected fixture request" }, 404);
  }
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const path = url.pathname, method = init.method || "GET";
    control.requests.push({ role: control.role, method, path, search: url.search });
    const respond = () => route(path, method, init.body ? JSON.parse(init.body) : undefined);
    const holdKey = control.hold.has(method + " " + path) ? method + " " + path : path;
    if (control.hold.delete(holdKey)) return new Promise((done) => { control.holds[holdKey] = () => { delete control.holds[holdKey]; done(respond()); }; });
    return respond();
  };
  async function route(path, method, body) {
    if (path === "/api/auth/status") return json({ setupRequired: false });
    if (path === "/api/auth/logout") {
      if (control.logoutFailure === 401) { control.role = "signedout"; return json({ error: "sign in required" }, 401); }
      if (control.logoutFailure) return json({ error: "Fixture sign-out unavailable" }, control.logoutFailure);
      control.role = "signedout";
      return json({ signedOut: true });
    }
    if (path === "/api/auth/login") { control.role = "viewer"; return json({ user: user("viewer"), csrfToken: "viewer-fixture-csrf" }); }
    if (control.htmlFailure) return new Response("<html>Fixture upstream failure</html>", { status: 502 });
    if (control.offline) throw new TypeError("Fixture dashboard connection unavailable");
    if (control.role === "signedout") return json({ error: "sign in required" }, 401);
    const admin = control.role === "admin";
    if (control.failSources.has(path)) return json({error: "Fixture source unavailable: " + path}, 503);
    if (control.failWrites.has(method + " " + path)) return json({error: "Fixture save unavailable; your draft is kept"}, 503);
    if (path === "/api/session") return json({ user: user(control.role), csrfToken: "fixture-csrf" });
    if (path === "/api/auth/recent") {
      if (control.authFailure) return json({ error: "Fixture verification unavailable" }, control.authFailure);
      control.recent = true;
      return json({ verified: true });
    }
    if (path === "/api/users" && method === "POST") {
      if (!admin) return json({error: "administrator required"}, 403);
      if (!control.recent) return recentRequired();
      if (control.createdUsers.length) return json({error: "Fixture account bound reached"}, 409);
      control.createdUsers.push({id: "temporary-account", name: body.name, role: body.role, active: true});
      return json({secret: "FIXTURE-ONLY-AUTHENTICATOR-SECRET"}, 201);
    }
    if (path === "/api/users") return control.usersFail ? json({ error: "Fixture account list unavailable" }, 503)
      : json([user("admin"), user("operator"), user("viewer"), { id: "unreadable-fixture", name: "unreadable-fixture", role: "operator", active: true }, ...control.createdUsers]);
    const grants = path.match(/^\/api\/users\/([^/]+)\/grants$/);
    if (grants && method === "GET") return grants[1] === "unreadable-fixture" ? json({ error: "Fixture grant read unavailable" }, 500) : json({ grants: control.grantStore[grants[1]] || [] });
    if (grants) {
      control.grantWrites++;
      if (method !== "PUT" || !control.recent) return recentRequired();
      if (!Array.isArray(body.expectedGrants)) return json({error:"Read the current grants before replacement"},428);
      const keys = entries => entries.map(g => JSON.stringify([g.scopeType,g.scope,g.action])).sort();
      if (JSON.stringify(keys(body.expectedGrants)) !== JSON.stringify(keys(control.grantStore[grants[1]] || []))) return json({error:"Saved grants changed; review the latest grant set"},409);
      control.lastGrantPut = { user: grants[1], ...body };
      control.grantStore[grants[1]] = body.grants;
      return json({});
    }
    if (path === "/api/projects" && method === "GET") return json({ projects: Object.values(control.projects).filter((p) => visible(p.id)).sort((a, b) => a.id.localeCompare(b.id)) });
    if (path === "/api/projects" && method === "POST") {
      if (!admin) return json({ error: "administrator required" }, 403);
      if (!control.recent) return recentRequired();
      if (control.projects[body.id]) return json({ error: "project ID already registered" }, 409);
      control.projects[body.id] = { id: body.id, name: body.name, description: body.description, modules: body.modules || [], archived: false, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
      record(body.id, "project.create");
      return json(control.projects[body.id], 201);
    }
    if (path.startsWith("/api/projects/")) return projectRoute(method, path, body);
    if (path === "/api/hosts") {
      refreshEvidence();
      const snapshot = { hosts: admin ? fixtureHosts : [viewerHost] };
      if (admin && control.holdHosts) {
        control.holdHosts = false;
        return new Promise((done) => { control.releaseHosts = () => { control.releaseHosts = null; done(json(snapshot)); }; });
      }
      return json(snapshot);
    }
    const hostWrite = path.match(/^\/api\/hosts\/([^/]+)(\/mappings|\/jobs)?$/);
    if (hostWrite && method !== "GET") {
      const h = fixtureHosts.find(h => h.id === hostWrite[1]);
      if (!admin || !h) return json({error: "action forbidden"}, 403);
      if (!hostWrite[2] && method === "PATCH") {
        if (!body.inventoryRevision) return json({error:"Read saved inventory before updating"},428);
        if (body.inventoryRevision !== inventoryRevision(h)) return json({error:"Saved inventory changed; reload saved values"},409);
        Object.assign(h, {name: body.name, tags: body.tags, groups: body.groups});
        h.inventoryRevision = inventoryRevision(h);
        return json(h);
      }
      if (hostWrite[2] === "/mappings" && method === "PUT") {
        if (body.mappings.length > 20) return json({error: "mapping limit exceeded"}, 400);
        canary.mappings = [...canary.mappings.filter(m => m.hostId !== h.id), ...body.mappings.map(m => ({...m, hostId: h.id}))];
        return json({mappings: body.mappings});
      }
      if (hostWrite[2] === "/jobs" && method === "POST") {
        if (!hostPermissions().includes(body.action)) return json({error:"action forbidden"}, 403);
        if (!h.verified || h.revoked) return json({error: "agent identity unavailable"}, 409);
        if (!["logs.read", "service.restart", "diagnostic", "host.reboot"].includes(body.action)) return json({error: "unexpected fixture action"}, 400);
        if (["service.restart", "host.reboot"].includes(body.action) && (!control.recent || body.confirm !== h.id)) return recentRequired();
        if (control.jobs.length >= 8) return json({error: "fixture job bound reached"}, 409);
        const createdAt = Date.now();
        const job = {id: `fixture-job-${control.jobs.length + 1}`, hostId: h.id, action: body.action, args: body.args, state: "queued", createdAt, expiresAt: createdAt + 300000, result: null};
        control.jobs.push(job);
        return json(job, 201);
      }
    }
    if (path === "/api/hosts/private-host") { refreshEvidence(); return admin ? json({ host: privateHost, samples: control.samples, permissions: hostPermissions() }) : json({ error: "action forbidden" }, 403); }
    if (path === "/api/hosts/viewer-host") { refreshEvidence(); return json({ host: viewerHost, samples: [], permissions: hostPermissions() }); }
    if (path === "/api/canary") { refreshEvidence(); return json(admin ? canary : emptyCanary); }
    if (path === "/api/jobs") return json(control.jobs.filter(j => admin || j.hostId === viewerHost.id).map(j => ({...jobView(j), result:null})));
    const jobRoute = path.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/);
    if (jobRoute) {
      const job = control.jobs.find(j => j.id === jobRoute[1]);
      if (!job) return json({error:"job not found"}, 404);
      if (!admin && job.hostId !== viewerHost.id) return json({error:"action forbidden"}, 403);
      if (jobRoute[2] && method === "POST") {
        if (!jobView(job).canCancel) return json({error:"action forbidden"}, 403);
        job.cancelRequested = true;
        if (job.state === "queued") { job.state = "cancelled"; job.finishedAt = Date.now(); }
        return json({requested:true});
      }
      if (!jobRoute[2] && method === "GET") return json({...jobView(job), hostName:fixtureHosts.find(h => h.id === job.hostId)?.name || job.hostId, canReadOutput:hostPermissions().includes("jobs.output"), result:hostPermissions().includes("jobs.output") ? job.result : null});
    }
    if (path === "/api/audit") return json(control.audit.filter(a => admin || a.hostId === viewerHost.id));
    return json({ error: "unexpected fixture request" }, 404);
  };
}

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = resolve(web, path === "/" ? "index.html" : `.${path}`);
  if (!file.startsWith(web + sep) || !existsSync(file)) { response.writeHead(404).end(); return; }
  const mime = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html";
  let body = readFileSync(file);
  if (file.endsWith("index.html")) body = Buffer.from(body.toString().replace("<head>", `<head><script>(${installFixture.toString()})(${visual});</script>`));
  response.writeHead(200, { "Content-Type": mime });
  response.end(body);
});
const chromePath = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
assert.ok(chromePath, "Linux CI runner must provide Chrome/Chromium");
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking",
  "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-pipe", `--user-data-dir=${join(scratch, "chrome-profile")}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null", DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/dev/null" } });
let sequence = 0, buffer = "", stderr = "";
const pending = new Map();
const errors = [];
chrome.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4096); });
chrome.on("error", (error) => { for (const call of pending.values()) call.reject(error); pending.clear(); });
chrome.on("exit", () => { for (const call of pending.values()) call.reject(new Error(`Chrome exited: ${stderr}`)); pending.clear(); });
chrome.stdio[4].on("data", (data) => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    const call = pending.get(message.id);
    if (!call) continue;
    pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolveCall, rejectCall) => {
    const id = ++sequence;
    // Cold Chrome startup on a disposable runner can outlast an ordinary RPC.
    const timeout = method === "Browser.getVersion" ? 30000 : 10000;
    const timer = setTimeout(() => { pending.delete(id); rejectCall(new Error(`Chrome timed out: ${method}; ${stderr}`)); }, timeout);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveCall(value); }, reject: (error) => { clearTimeout(timer); rejectCall(error); } });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}

try {
  const version = await send("Browser.getVersion");
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    // Keep bounded, fixture-only state and the failed view for CI diagnosis.
    try {
      const state = await evaluate(`({route:location.hash.slice(0,200), heading:document.querySelector('h1')?.textContent?.slice(0,100), resources:document.querySelector('.host-resources')?.textContent?.slice(0,600), warnings:document.querySelector('.source-warning')?.textContent?.slice(0,600), fixtureCPU:window.fixture?.hosts?.[0]?.latest?.cpuPercent, offline:window.fixture?.offline, htmlFailure:window.fixture?.htmlFailure, holds:Object.keys(window.fixture?.holds || {}).slice(0,8).map(path => path.slice(0,180)), recentRequests:window.fixture?.requests?.slice(-8).map(({method,path}) => ({method,path:path.slice(0,180)}))})`);
      const scroll = await evaluate("({actual:scrollY,expected:window.fixture?.returnScroll,mode:history.scrollRestoration,activeHref:document.activeElement?.getAttribute('href')?.slice(0,200)})");
      const report = JSON.stringify({condition:expression.slice(0,1500), state, scroll, runtimeErrors:errors.slice(-3).map(error => String(error).slice(0,512))}, null, 2);
      if (Buffer.byteLength(report) <= 16384) writeFileSync(join(evidence, "failure-state.json"), report);
    } catch {}
    try { await capture("99-failure"); } catch {}
    throw new Error(`Browser assertion timed out: ${expression}`);
  };
  const click = async (text) => {
    let point;
    try {
      point = await evaluate(`(async () => { await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); const root = document.querySelector('dialog[open]') || document; const button = [...root.querySelectorAll('button,a')].find(b => !b.closest('details:not([open])') && b.checkVisibility() && b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!button) throw Error('Missing visible fixture control: ' + ${JSON.stringify(text)}); button.scrollIntoView({block:'center'}); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); const r = button.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2; if (!button.isConnected || document.elementFromPoint(x,y)?.closest('button,a') !== button) throw Error('Fixture control is obstructed or changed: ' + ${JSON.stringify(text)}); return {x,y}; })()`);
    } catch (error) {
      try {
        const state = await evaluate("({route:location.hash.slice(0,200),heading:document.querySelector('h1')?.textContent?.slice(0,100),width:innerWidth,height:innerHeight,scrollY,activeTag:document.activeElement?.tagName,openDialog:!!document.querySelector('dialog[open]')})");
        const report = JSON.stringify({control:text.slice(0,100),state,error:String(error).slice(0,1500)},null,2);
        if (Buffer.byteLength(report) <= 16384) writeFileSync(join(evidence, "click-failure-state.json"),report);
        await capture("99-click-failure");
      } catch {}
      throw error;
    }
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, sessionId);
  };
  const screenshots = [];
  let cases = 0;
  const pass = (name) => { cases++; console.log(`PASS ${name}`); };
  const sleep = (ms) => evaluate(`new Promise(done => setTimeout(done, ${ms}))`);
  // Advance only the resume event's clock. Poll scheduling and fixture response
  // timestamps keep real time, and a coincident interval cannot make this flaky.
  const ageUntil = (condition, offset) => wait(`(() => {
    if (${condition}) return true;
    const realNow = Date.now;
    try { Date.now = () => realNow() + ${offset}; window.dispatchEvent(new Event('focus')); }
    finally { Date.now = realNow; }
    return false;
  })()`);
  // React controlled inputs need the native setter plus an input/change event.
  const setValue = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing fixture field'); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`);
  const submit = (label) => evaluate(`document.querySelector('form[aria-label=${JSON.stringify(label)}]').requestSubmit()`);
  const goodChips = "document.querySelectorAll('.github .chip.good').length";
  const token = "FIXTURE-ONLY-TOKEN-0123456789abcdef";
  const capture = async (name) => {
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const png = Buffer.from(data, "base64");
    assert.ok(png.length <= 2 * 1024 ** 2, "Screenshot exceeds evidence bound");
    writeFileSync(join(evidence, `${name}.png`), png);
    screenshots.push(`${name}.png`);
    if (visual) console.log(`Captured ${screenshots.length}: ${name}`);
  };
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.bringToFront", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?hold=1` }, sessionId);
  await wait("document.body?.innerText.includes('Loading host inventory') && typeof window.fixture.holds['/api/hosts'] === 'function' && typeof window.fixture.holds['/api/canary'] === 'function'");
  assert.ok(await evaluate("!document.body.innerText.includes('Your fleet starts here') && !document.body.innerText.includes('Not configured') && !document.body.innerText.includes('No verified source')"), "Pending initial requests imply confirmed absence");
  if (visual) await capture("fleet-loading-desktop");
  await evaluate("window.fixture.holds['/api/hosts'](); history.replaceState(null, '', location.pathname + location.hash)");
  await wait("document.body?.innerText.includes('ADMIN-ONLY-HOST')");
  assert.ok(await evaluate("[...document.querySelectorAll('.metric')].find(m => m.innerText.includes('Canary sources'))?.innerText.includes('Loading')"), "A successful host read implies Canary configuration");
  await evaluate("window.fixture.holds['/api/canary']()");
  await wait("[...document.querySelectorAll('.metric')].find(m => m.innerText.includes('Canary sources'))?.innerText.includes('1 / 1')");
  await click("Remote jobs");
  await wait("document.querySelector('.jobs-panel')?.innerText.includes('Loading job history') && typeof window.fixture.holds['/api/jobs'] === 'function'");
  assert.ok(await evaluate("!document.body.innerText.includes('No jobs in this history window') && document.querySelector('.job-filters input').disabled"), "Pending first job read implies empty history or enables filtering");
  if (visual) await capture("jobs-loading-desktop");
  await evaluate("window.fixture.holds['/api/jobs']()");
  await wait("document.querySelector('.jobs-panel')?.innerText.includes('No jobs in this history window')");
  await evaluate("location.hash = '#/jobs/missing-fixture-job'");
  await wait("!!document.querySelector('dialog[open] [role=alert]')");
  await click("×");
  await wait("location.hash === '#/jobs' && !document.querySelector('dialog[open]')");
  await click("Activity & audit");
  await wait("document.body.innerText.includes('Loading activity history') && typeof window.fixture.holds['/api/audit'] === 'function'");
  assert.ok(await evaluate("!document.body.innerText.includes('No activity in view')"), "Pending first activity read implies confirmed absence");
  if (visual) await capture("activity-loading-desktop");
  await evaluate("window.fixture.holds['/api/audit']()");
  await wait("document.body.innerText.includes('No activity in view')");
  await click("Fleet overview");
  await wait("!!document.querySelector('.fleet-table')");
  if (visual) {
    await captureUI({ send, sessionId, evaluate, wait, click, capture });
  } else {
  pass("first host and Canary loads remain unknown until each source independently responds");
  pass("job and activity history show first-read loading before independently confirmed empty results");
  // Native modal focus, background inertness and durable in-dialog errors.
  await click("Verify identity");
  await wait("document.querySelector('dialog[open]') && document.activeElement?.name === 'password'");
  await evaluate("window.fixture.authFailure = 503");
  await setValue("dialog input[name=password]", "temporary fixture password");
  await setValue("dialog input[name=code]", "123456");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await wait("document.querySelector('dialog [role=alert]')?.textContent.includes('Fixture verification unavailable')");
  await sleep(5500);
  assert.ok(await evaluate("document.querySelector('dialog [role=alert]')?.textContent.includes('Fixture verification unavailable')"), "Successful background polling cleared a mutation error");
  await evaluate("document.querySelector('nav a').focus()");
  assert.ok(await evaluate("document.querySelector('dialog').contains(document.activeElement)"), "Modal focus escaped to the inert background");
  await capture("10-dialog-verification-error");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await wait("!document.querySelector('dialog') && document.activeElement?.textContent === 'Verify identity'");
  await evaluate("window.fixture.authFailure = 0");
  pass("verification errors remain in a keyboard-contained modal across polling; Escape restores focus");

  await click("Verify identity");
  await setValue("dialog input[name=password]", "temporary fixture password");
  await setValue("dialog input[name=code]", "123456");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await wait("!document.querySelector('dialog') && document.querySelector('.status-notice time')?.dateTime && document.querySelector('.status-notice').innerText.includes('Verify again after')");
  await sleep(100);
  await evaluate("(() => { const now = Date.now; try { Date.now = () => now() + 301000; window.dispatchEvent(new Event('focus')); } finally { Date.now = now; } })()");
  await wait("[...document.querySelectorAll('.status-notice')].some(s => s.innerText.includes('Recent verification expired')) && !document.querySelector('.status-notice time')");
  pass("verification explains its scope, shows an expiry and stops claiming current verification after expiry");
  // End the expiry simulation before pointer navigation: the future clock also
  // ages fleet readings, whose recovery changes row layout on the next tick.
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await wait("document.querySelectorAll('.fleet-table td[data-label=\"Agent connection\"] .chip.good').length === 2 && document.querySelectorAll('.fleet-table td[data-label=\"Reading freshness\"] .chip.good').length === 2 && !document.querySelector('.usage.stale')");

  // Real destinations survive history and a new document, with heading focus.
  assert.equal(await evaluate("document.querySelector('nav a[href=\"#/projects\"]')?.getAttribute('href')"), "#/projects");
  await click("ADMIN-ONLY-HOST");
  await wait("location.hash === '#/hosts/private-host' && document.querySelector('h1')?.textContent === 'ADMIN-ONLY-HOST' && document.activeElement === document.querySelector('h1')");
  await evaluate("history.back()");
  await wait("location.hash === '#/fleet' && document.activeElement === document.querySelector('h1')");
  await evaluate("history.forward()");
  await wait("location.hash === '#/hosts/private-host' && document.querySelector('h1')?.textContent === 'ADMIN-ONLY-HOST'");
  await send("Page.reload", {}, sessionId);
  // Wait for the new execution context; no application or assertion errors are ignored.
  await new Promise(done => setTimeout(done, 300));
  await wait("location.hash === '#/hosts/private-host' && document.querySelector('h1')?.textContent === 'ADMIN-ONLY-HOST' && document.activeElement === document.querySelector('h1')");
  await click("← All hosts");
  await wait("location.hash === '#/fleet'");
  pass("real host/project links preserve destinations across Back, Forward and reload, and focus page headings");

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  await evaluate("document.querySelector('.mobile-navigation summary').click()");
  await wait("document.querySelector('.mobile-navigation').open");
  assert.ok(await evaluate("[...document.querySelectorAll('.mobile-account button')].some(b => b.textContent === 'Sign out' && b.getClientRects().length)"), "Mobile sign-out is not discoverable");
  await click("Projects");
  await wait("document.querySelector('h1')?.textContent === 'Projects' && !document.querySelector('.mobile-navigation').open && document.activeElement === document.querySelector('h1')");
  assert.ok(await evaluate("document.querySelector('.mobile-navigation [aria-current=page]')?.textContent.includes('Projects')"), "Mobile current destination is not exposed");
  await evaluate("document.querySelector('.mobile-navigation summary').click()");
  const priorMode = await evaluate("document.documentElement.dataset.mode");
  await click("Switch appearance");
  assert.notEqual(await evaluate("document.documentElement.dataset.mode"), priorMode);
  await click("Switch appearance");
  await capture("11-mobile-navigation");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 390, deviceScaleFactor: 1, mobile: true }, sessionId);
  assert.ok(await evaluate(`(() => {
    const menu = document.querySelector('.mobile-menu-body');
    menu.scrollTop = menu.scrollHeight;
    const button = [...menu.querySelectorAll('button')].find(b => b.textContent === 'Sign out');
    button.focus(); const r = button.getBoundingClientRect();
    return r.bottom <= innerHeight && r.top >= 0 && document.elementFromPoint(r.x + r.width/2,r.y + r.height/2) === button;
  })()`), "Short mobile viewport makes sign-out unreachable");
  assert.ok(await evaluate("document.querySelector('.mobile-menu-body .compact-navigation select').checkVisibility() && document.querySelector('.mobile-menu-body .compact-navigation select').options.length === 6 && !document.querySelector('.mobile-menu-body nav').checkVisibility()"), "Short mobile navigation does not expose all workspace destinations in its native picker");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await wait("!document.querySelector('.mobile-navigation').open && document.activeElement === document.querySelector('.mobile-navigation summary')");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  await evaluate("document.querySelector('.mobile-navigation summary').click()");
  await click("Fleet overview");
  await wait("!!document.querySelector('.fleet-table')");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.fleet-table').scrollWidth <= innerWidth"), "Host statuses require horizontal document/table scrolling on mobile");
  assert.equal(await evaluate("[...document.querySelector('.fleet-table tbody tr').querySelectorAll('.chip')].filter(c => c.checkVisibility() && /fresh/i.test(c.textContent)).length"), 1, "Mobile host repeats its reading freshness status");
  const accessibleFleet = (await send("Accessibility.getFullAXTree", {}, sessionId)).nodes.filter(n => !n.ignored);
  assert.ok(accessibleFleet.some(n => n.role?.value === "table"), "Responsive fleet lost its accessible table role");
  const columnNames = accessibleFleet.filter(n => n.role?.value === "columnheader").map(n => String(n.name?.value || "").trim().replace(/\s+/g, " ").toLowerCase());
  for (const column of ["Host", "Canary uptime", "Agent connection", "Reading freshness", "Resources"]) assert.ok(columnNames.includes(column.toLowerCase()), `Responsive fleet lost header: ${column}; accessible headers: ${JSON.stringify(columnNames)}`);
  assert.equal(await evaluate("document.querySelector('.fleet-table td[data-label=Resources]').getAttribute('aria-colindex')"), "5", "Hidden mobile freshness cell shifted the resource column association");
  assert.ok(await evaluate("[...document.querySelectorAll('.fleet-table tbody tr')].filter(r => r.getBoundingClientRect().bottom <= innerHeight).length >= 2 && document.querySelector('.resource-details > summary').innerText.includes('CPU 12.0%')"), "Compact mobile inventory cannot compare two complete hosts or see resource summaries without expansion");
  await evaluate("document.querySelector('.fleet-summary > summary').click()");
  assert.ok(await evaluate("document.querySelector('.mobile-enroll').checkVisibility() && document.querySelector('.fleet-summary > summary').textContent.includes('enrollment')"), "Existing-fleet enrollment is not discoverable in the mobile summary");
  await evaluate("document.querySelector('.fleet-summary > summary').click()");
  pass("compact mobile rows expose independent statuses and resource summaries while fitting two complete hosts");
  pass("Chrome accessibility tree retains mobile table and column headers with explicit column positions");
  await evaluate("window.fixture.longFleet()");
  await wait("document.querySelectorAll('.fleet-table tbody tr').length === 12");
  await evaluate("document.querySelector('.fleet-view-control input').click()");
  await wait("!!document.querySelector('.fleet-compare')");
  assert.ok(await evaluate("document.querySelector('.fleet-table thead').checkVisibility() && [...document.querySelectorAll('.fleet-table tbody tr')].every(r => r.querySelector('[data-label=\"Reading freshness\"]').checkVisibility()) && document.documentElement.scrollWidth <= innerWidth"), "Comparison mode hides independent status evidence or overflows");
  const compareRowHeight = await evaluate("document.querySelector('.fleet-table tbody tr').getBoundingClientRect().height");
  assert.ok(await evaluate("document.querySelector('.fleet-table .comparison-resource-summary').checkVisibility() && document.querySelector('.fleet-table .comparison-resource-summary').textContent.includes('CPU 12.0%')"), "Comparison requires opening a host to see ordinary resource readings");
  await evaluate("document.querySelector('.fleet-table tbody tr:nth-child(7)').scrollIntoView({block:'start'})");
  await wait("(() => { const head = document.querySelector('.fleet-table thead').getBoundingClientRect(); const bar = document.querySelector('.topbar').getBoundingClientRect(); return scrollY > 0 && head.top >= bar.bottom - 1 && head.top <= bar.bottom + 2 && head.bottom < innerHeight; })()");
  await evaluate("window.scrollTo(0,0); window.fixture.hosts.splice(2)");
  await evaluate("document.querySelector('.fleet-view-control input').click()");
  await wait("!document.querySelector('.fleet-compare')");
  assert.ok(compareRowHeight < await evaluate("document.querySelector('.fleet-table tbody tr').getBoundingClientRect().height"), "Optional comparison mode does not reduce row height");
  pass("optional mobile comparison retains resource readings and visible independent headings during long scrolling while reducing row height");
  await evaluate("window.fixture.hosts[0].resourceHealth = 'warning'; window.fixture.hosts[0].latest.cpuPercent = 96");
  await wait("document.querySelector('.attention-filter')?.textContent.includes('(1)') && [...document.querySelectorAll('.mobile-resource-warning .chip')].some(c => c.checkVisibility() && c.textContent.includes('Resource warning'))");
  assert.equal(await evaluate("document.querySelector('.resource-details').open"), false, "Resource-warning proof needs a collapsed card");
  await click("Agent & resource issues");
  await wait("document.querySelector('.attention-filter').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.fleet-table tbody tr').length === 1 && document.querySelector('.fleet-table').innerText.includes('ADMIN-ONLY-HOST')");
  assert.ok(await evaluate("document.querySelector('.compact-freshness').innerText.toLowerCase().includes('fresh readings')"), "Resource warning incorrectly changed independent reading freshness");
  assert.ok(await evaluate("document.querySelector('.resource-details > summary').innerText.includes('CPU 96.0%') && !document.querySelector('.mobile-resource-warning').innerText.includes('CPU')"), "Resource warning hides or duplicates its current measurement");
  await evaluate("document.querySelector('.fleet-view-control input').click()");
  await wait("!!document.querySelector('.fleet-compare')");
  assert.ok(await evaluate("document.querySelector('.fleet-compare .desktop-resource-warning').checkVisibility() && document.querySelector('.fleet-compare .comparison-resource-summary').checkVisibility() && document.querySelector('.fleet-compare .comparison-resource-summary').textContent.includes('CPU 96.0%')"), "Comparison mode conceals resource-warning evidence");
  await evaluate("document.querySelector('.fleet-view-control input').click()");
  await wait("!document.querySelector('.fleet-compare')");
  await evaluate("window.fixture.hosts[0].resourceHealth = 'normal'; window.fixture.hosts[0].latest.cpuPercent = 12; window.fixture.hosts[1].connectivity = 'unknown'; window.fixture.hosts[1].freshness = 'unknown'");
  await wait("document.querySelectorAll('.fleet-table tbody tr').length === 1 && document.querySelector('.fleet-table tbody').innerText.includes('Viewer fixture host')");
  await evaluate("window.fixture.hosts[1].connectivity = 'connected'; window.fixture.hosts[1].freshness = 'fresh'");
  await wait("document.body.innerText.includes('No matching hosts')");
  await click("Show all hosts");
  await wait("document.querySelectorAll('.fleet-table tbody tr').length === 2");
  pass("collapsed mobile cards expose resource-warning causes, include unknown evidence in the issues filter and preserve independent freshness");
  await evaluate("document.querySelector('.resource-details > summary').click()");
  await wait("document.querySelector('.mobile-host-evidence')?.checkVisibility()");
  await click("Just now");
  assert.ok(await evaluate("(() => {const b = [...document.querySelectorAll('.time-trigger')].find(b => b.getAttribute('aria-expanded') === 'true'); const exact = b && document.getElementById(b.getAttribute('aria-controls')); return exact?.checkVisibility() && exact.textContent.length > 15;})()"), "Exact operational times are not available by tap");
  await click("Just now");
  await click("ADMIN-ONLY-HOST");
  await wait("document.querySelector('h1')?.textContent === 'ADMIN-ONLY-HOST'");
  assert.ok(await evaluate(`(() => {
    const heading = document.querySelector('.page-heading h1'), identity = document.querySelector('.page-heading code');
    const name = heading.textContent, id = identity.textContent;
    try { heading.textContent = 'h'.repeat(80); identity.textContent = 'a'.repeat(64); return document.documentElement.scrollWidth <= innerWidth; }
    finally { heading.textContent = name; identity.textContent = id; }
  })()`), "Long host names or identity IDs overflow the mobile document");
  await evaluate("window.fixture.populateHistory()");
  await wait("!!document.querySelector('.history svg')");
  await evaluate("document.querySelector('.history-data').open = true");
  assert.ok(await evaluate("document.querySelector('.history-summary').innerText.includes('12.0–64.0%') && document.querySelector('.history-data').innerText.includes('Not measured') && document.querySelector('.history-data').innerText.includes('Gap before this reading')"), "Populated CPU history lacks equivalent values or missing-data context");
  assert.ok(await evaluate("[...document.querySelectorAll('.history-axis span')].map(s => s.textContent).join(',') === '100%,50%,0%' && [...document.querySelectorAll('.history-point')].every(p => p.getBoundingClientRect().width >= 7) && document.querySelectorAll('.history-ticks time').length === 3"), "CPU chart lacks readable reference values, time ticks or screen-sized markers");
  await evaluate("window.fixture.samples = []");
  pass("CPU history exposes a range summary and bounded chronological readings including missing values and gaps");
  for (const id of ["host-overview", "host-history", "host-services", "host-processes", "host-configuration", "host-jobs"]) {
    await evaluate(`(() => { const picker = document.querySelector('.host-section-links select'); picker.value = ${JSON.stringify(id)}; picker.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await wait(`!!document.activeElement.closest('#${id}') && location.hash === '#/hosts/private-host'`);
    assert.ok(await evaluate(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return r.top >= document.querySelector('.topbar').getBoundingClientRect().bottom && r.top < innerHeight; })()`), `Host section ${id} is obscured by the sticky header or outside the viewport`);
  }
  pass("every mobile host-section jump retains focus and clears the sticky header");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await click("Configuration");
  assert.ok(await evaluate("document.querySelector('.host-configuration').open && document.activeElement.closest('.host-configuration') && location.hash === '#/hosts/private-host'"), "Host section shortcut lost route, focus or disclosure access");
  await setValue('form[aria-label="Host inventory"] input[name=name]', 'Unsaved host draft');
  await evaluate("document.querySelector('.host-mapping-form input[type=checkbox]').click(); window.confirm = () => false");
  await click("Fleet overview");
  assert.ok(await evaluate("location.hash === '#/hosts/private-host' && document.querySelector('.host-inventory-form input[name=name]').value === 'Unsaved host draft' && !document.querySelector('.host-mapping-form input[type=checkbox]').checked"), "Host drafts were lost on declined navigation");
  await evaluate(`(() => {
    window.fixture.hosts[0].name = 'External host update';
    const source = window.fixture.canary.sources[0];
    source.monitors.push({...structuredClone(source.monitors[0]), monitor: {...source.monitors[0].monitor, id: 'secondary', name: 'Secondary fixture monitor'}});
    window.fixture.canary.mappings = [{hostId:'private-host',sourceId:'fixture-source',monitorId:'secondary'}];
  })()`);
  await wait("[...document.querySelectorAll('.host-form-feedback .retained')].length === 2");
  assert.ok(await evaluate("document.querySelector('.host-inventory-form input[name=name]').value === 'Unsaved host draft' && [...document.querySelectorAll('.host-mapping-form input[type=checkbox]')].every(c => !c.checked)"), "Polling replaced a dirty host or mapping draft");
  await evaluate("document.querySelectorAll('.host-form-feedback .retained button:first-of-type').forEach(b => b.click())");
  pass("host inventory and monitor mapping drafts block navigation and survive independently changed saved values");
  await evaluate("window.fixture.failWrites.add('PATCH /api/hosts/private-host')");
  await submit("Host inventory");
  await wait("document.querySelector('.host-inventory-form [role=alert]')?.innerText.includes('Fixture save unavailable')");
  assert.equal(await evaluate("document.querySelector('.host-inventory-form input[name=name]').value"), "Unsaved host draft");
  await evaluate("window.fixture.failWrites.clear(); window.fixture.hold.add('PATCH /api/hosts/private-host')");
  await submit("Host inventory");
  await wait("typeof window.fixture.holds['PATCH /api/hosts/private-host'] === 'function' && document.querySelector('.host-inventory-form fieldset').disabled");
  const inventoryWrites = await evaluate("window.fixture.requests.filter(r => r.method === 'PATCH').length");
  await submit("Host inventory");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'PATCH').length"), inventoryWrites, "Pending inventory was submitted twice");
  await evaluate("window.fixture.holds['PATCH /api/hosts/private-host']()");
  await wait("document.querySelector('.host-inventory-form .status-notice').innerText.includes('Host inventory saved') && !document.querySelector('.host-inventory-form fieldset').disabled");
  await setValue('.host-inventory-form input[name=name]', 'Concurrent local draft');
  await evaluate("window.fixture.hold.add('PATCH /api/hosts/private-host')");
  await submit("Host inventory");
  await wait("typeof window.fixture.holds['PATCH /api/hosts/private-host'] === 'function'");
  await evaluate("window.fixture.hosts[0].name = 'Concurrent saved name'; window.fixture.hosts[0].groups = ['Operations']; window.fixture.hold.add('GET /api/hosts/private-host'); window.fixture.holds['PATCH /api/hosts/private-host']()");
  await wait("typeof window.fixture.holds['GET /api/hosts/private-host'] === 'function' && document.querySelector('.host-inventory-form').innerText.includes('Reload saved inventory')");
  assert.ok(await evaluate("document.querySelector('.host-inventory-form input[name=name]').value === 'Concurrent local draft' && document.querySelector('.host-inventory-form button.primary').disabled && window.fixture.hosts[0].name === 'Concurrent saved name'"), "Inventory conflict discarded the draft or overwrote saved fields before a fresh read");
  await evaluate("window.fixture.holds['GET /api/hosts/private-host']()");
  await wait("document.querySelector('.host-inventory-form .host-form-feedback .retained')?.innerText.includes('Keep my draft')");
  const conflictWrites = await evaluate("window.fixture.requests.filter(r => r.method === 'PATCH').length");
  await evaluate("[...document.querySelectorAll('.host-inventory-form button')].find(b => b.textContent === 'Keep my draft').click()");
  assert.ok(await evaluate("document.querySelector('.host-inventory-form input[name=name]').value === 'Concurrent local draft' && document.querySelector('.host-inventory-form input[name=groups]').value === 'Operations'"), "Reapplying a name edit restored old permission-bearing groups");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'PATCH').length"), conflictWrites, "Review choice saved inventory without explicit submission");
  await submit("Host inventory");
  await wait("window.fixture.hosts[0].name === 'Concurrent local draft' && document.querySelector('.host-inventory-form .status-notice').innerText.includes('Host inventory saved')");
  assert.deepEqual(await evaluate("window.fixture.hosts[0].groups"), ["Operations"]);
  pass("inventory revision conflicts retain the draft, wait for saved values and reapply only edited fields without restoring newer groups");
  await evaluate("window.fixture.hold.add('PUT /api/hosts/private-host/mappings')");
  await submit("Host monitor mappings");
  await wait("typeof window.fixture.holds['PUT /api/hosts/private-host/mappings'] === 'function' && document.querySelector('.host-mapping-form fieldset').disabled");
  await submit("Host monitor mappings");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'PUT' && r.path.endsWith('/mappings')).length"), 1, "Pending mappings were submitted twice");
  await evaluate("window.fixture.holds['PUT /api/hosts/private-host/mappings']()");
  await wait("document.querySelector('.host-mapping-form .status-notice').innerText.includes('Monitor mappings saved') && window.fixture.canary.mappings.length === 0");
  pass("host saves retain failed drafts, freeze submitted values, reject duplicate submissions and report results beside each form");

  await evaluate("window.fixture.hold.add('POST /api/hosts/private-host/jobs')");
  await click("Request logs");
  await wait("typeof window.fixture.holds['POST /api/hosts/private-host/jobs'] === 'function' && document.querySelector('.service-requests').getAttribute('aria-busy') === 'true'");
  assert.ok(await evaluate("[...document.querySelectorAll('.service-requests button')].every(b => b.disabled) && document.querySelector('.service-pending').innerText.includes('No execution is confirmed')"), "Pending service request lacks local progress or leaves repeat submission enabled");
  await evaluate("document.querySelector('.service-requests button').click(); document.querySelector('.service-requests button').click()");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/jobs')).length"), 1);
  await evaluate("window.fixture.holds['POST /api/hosts/private-host/jobs']()");
  await wait("document.querySelector('.service-requests .status-notice').innerText.includes('Request queued')");
  assert.ok(await evaluate("location.hash === '#/hosts/private-host' && document.querySelector('.service-requests a').getAttribute('href') === '#/jobs/fixture-job-1' && window.fixture.jobs[0].expiresAt - window.fixture.jobs[0].createdAt === 300000"), "Queued receipt lost context or did not explain a bounded job");
  await evaluate("window.confirm = () => false");
  await click("Request restart");
  assert.equal(await evaluate("window.fixture.jobs.length"), 1, "Cancelled restart queued a request");
  await evaluate("window.confirm = () => true; window.fixture.recent = false");
  await click("Request restart");
  await wait("document.querySelector('.service-requests [role=alert]')?.innerText.includes('Verify identity')");
  assert.equal(await evaluate("window.fixture.jobs.length"), 1, "Restart bypassed recent verification in fixture");
  await evaluate("window.fixture.recent = true; window.fixture.hold.add('POST /api/hosts/private-host/jobs')");
  await click("Request restart");
  await wait("typeof window.fixture.holds['POST /api/hosts/private-host/jobs'] === 'function'");
  await evaluate("window.fixture.holds['POST /api/hosts/private-host/jobs']()");
  await wait("window.fixture.jobs.length === 2 && document.querySelector('.service-requests .status-notice').innerText.includes('Request queued')");
  pass("service requests prevent repeat clicks, retain local progress/receipts and preserve restart confirmation and recent-verification gates");
  await click("View outcome");
  await wait("location.hash === '#/jobs/fixture-job-2' && document.querySelector('dialog[open] .status-notice')?.innerText.includes('queued')");
  assert.ok(await evaluate("!!document.activeElement.closest('dialog[open]')"), "Navigating to a job outcome moved focus outside its modal");
  assert.ok(await evaluate("document.querySelector('.job-target').innerText.includes(window.fixture.hosts[0].name) && document.querySelector('.job-target').innerText.includes(window.fixture.jobs[1].args.service) && document.querySelector('dialog h2').innerText.includes('Service restart') && document.querySelector('.job-output-state').innerText.includes('Not dispatched yet') && !document.querySelector('.job-lifecycle').innerText.includes('Never')"), "Copied job outcome lacks its target or an explicit queued state");
  await evaluate("Object.assign(window.fixture.jobs[1], {state:'succeeded', dispatchedAt:window.fixture.jobs[1].createdAt + 1, finishedAt:Date.now(), result:{exitCode:0, stdout:'Bounded completed fixture output', stderr:'', truncated:false}}); window.fixture.hold.add('GET /api/jobs/fixture-job-2')");
  await click("Refresh status");
  await wait("typeof window.fixture.holds['GET /api/jobs/fixture-job-2'] === 'function' && document.querySelector('.job-status-tools button').disabled");
  await evaluate("window.fixture.holds['GET /api/jobs/fixture-job-2']()");
  await wait("document.querySelector('dialog[open]')?.innerText.includes('Bounded completed fixture output') && document.querySelector('dialog[open] .status-notice').innerText.includes('succeeded')");
  assert.ok(await evaluate("!document.querySelector('dialog[open]').innerText.includes('Never')"), "Completed job fixture omitted its dispatch or finish time");
  pass("service receipt opens the exact URL-addressable job and refreshes its queued status to the completed outcome");
  await evaluate("window.fixture.hostPermissions = ['host.read']");
  await click("Refresh status");
  await wait("document.querySelector('.job-output-state')?.innerText.includes('does not have permission')");
  assert.ok(await evaluate("!document.querySelector('dialog').innerText.includes('Bounded completed fixture output')"), "Restricted job output remained visible");
  await evaluate("window.fixture.hostPermissions = null; window.fixture.jobs[1].result = null");
  await click("Refresh status");
  await wait("document.querySelector('.job-output-state')?.innerText.includes('No command output was recorded')");
  await evaluate("window.fixture.jobs[1].result = {exitCode:0,stdout:'Bounded completed fixture output',stderr:'',truncated:false}");
  await click("Refresh status");
  await wait("document.querySelector('dialog').innerText.includes('Bounded completed fixture output')");
  pass("job outcomes identify their host and service and distinguish queued, restricted and missing output without retaining restricted data");
  await evaluate("window.fixture.failSources.add('/api/jobs/fixture-job-2')");
  await click("Refresh status");
  await wait("!!document.querySelector('dialog[open] [role=alert]')");
  assert.ok(await evaluate("!document.querySelector('dialog[open]').innerText.includes('Bounded completed fixture output')"), "Unavailable job read retained prior command output");
  await evaluate("window.fixture.failSources.clear()");
  await click("Refresh status");
  await wait("document.querySelector('dialog[open]')?.innerText.includes('Bounded completed fixture output')");
  await click("×");
  await wait("location.hash === '#/hosts/private-host' && !!document.querySelector('.service-requests')");
  pass("job status errors clear old output, allow an explicit retry and close to the initiating host");
  await click("Jobs");
  await setValue("#host-jobs input[name=jobSearch]", "fixture-job-1");
  await wait("document.querySelectorAll('#host-jobs tbody tr').length === 1");
  await evaluate("window.fixture.returnScroll = scrollY; const link = document.querySelector('#host-jobs td[data-label=Outcome] > a'); link.focus({preventScroll:true}); link.click()");
  await wait("location.hash === '#/jobs/fixture-job-1' && !!document.querySelector('dialog[open]')");
  await evaluate("const close = document.querySelector('dialog .close'); close.click(); close.click()");
  await wait("location.hash === '#/hosts/private-host' && document.querySelector('#host-jobs input[name=jobSearch]')?.value === 'fixture-job-1' && document.querySelectorAll('#host-jobs tbody tr').length === 1 && document.activeElement.getAttribute('href') === '#/jobs/fixture-job-1' && Math.abs(scrollY - window.fixture.returnScroll) <= 2");
  await click("Clear filters");
  pass("outcome closing restores host filters, scroll and focus, while direct job links fall back to global jobs");
  await evaluate("window.fixture.hostPermissions = ['host.read','logs.read']");
  await wait("document.querySelector('.service-requests button:nth-child(2)').disabled && !document.querySelector('.service-requests button:first-child').disabled && document.querySelector('.host-permission-context')?.innerText.includes('service logs')");
  assert.ok(await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Run diagnostic').disabled && document.querySelector('.host-actions button').disabled && document.querySelector('.host-inventory-form fieldset').disabled && document.querySelector('.service-permission-note').innerText.includes('not permitted')"), "Action controls ignored effective host permissions");
  const jobsBeforeDenied = await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/jobs')).length");
  await evaluate("document.querySelector('.service-requests button:nth-child(2)').click()");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/jobs')).length"), jobsBeforeDenied, "Disabled ungranted action submitted a request");
  await wait("document.querySelector('#host-jobs td[data-label=Outcome] button')?.disabled && document.querySelector('#host-jobs').innerText.includes('Cancellation not permitted')");
  await click("Remote jobs");
  await wait("location.hash === '#/jobs' && [...document.querySelectorAll('#content button')].some(b => b.textContent === 'Cancel' && b.disabled)");
  await setValue("input[name=jobSearch]", "NO-MATCHING-FIXTURE");
  await wait("document.querySelector('.jobs-panel').innerText.includes('No matching jobs within the latest 200') && !document.querySelector('.jobs-table')");
  assert.ok(await evaluate("!document.querySelector('.jobs-panel').innerText.includes('No jobs in this history window')"), "A zero-match filter implies empty job history");
  await click("Clear filters");
  await setValue("select[name=jobAction]", "logs.read");
  await setValue("select[name=jobState]", "succeeded");
  await wait("!document.querySelector('.jobs-table')");
  await setValue("select[name=jobState]", "queued");
  await setValue("input[name=jobSearch]", "private-host");
  await wait("document.querySelectorAll('.jobs-table tbody tr').length === 1 && document.querySelector('.jobs-table td[data-label=Outcome] > a').getAttribute('href') === '#/jobs/fixture-job-1'");
  await evaluate("document.querySelector('.jobs-table td[data-label=Outcome] > a').click()");
  await wait("location.hash === '#/jobs/fixture-job-1' && !!document.querySelector('dialog[open]')");
  await click("×");
  await wait("location.hash === '#/jobs' && document.querySelector('select[name=jobAction]').value === 'logs.read' && document.querySelectorAll('.jobs-table tbody tr').length === 1");
  assert.equal(await evaluate("document.querySelector('.jobs-table td[data-label=Host] > a')?.getAttribute('href')"), "#/hosts/private-host", "Global jobs lose the direct loaded-host destination");
  assert.ok(await evaluate("document.querySelector('.job-filter-count').innerText.includes('1 of 2') && document.querySelector('.jobs-panel .panel-heading').innerText.includes('Within latest 200')"), "Job filters hide their bounded scope or fail to combine target, action and state");
  await click("Clear filters");
  await wait("document.querySelectorAll('.jobs-table tbody tr').length === 2");
  pass("job search and combined state/action filters narrow authorized loaded history and distinguish no matches from no history");
  await send("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true}, sessionId);
  await evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
  await evaluate("document.querySelector('.job-cancel summary').click()");
  await wait("document.querySelector('.job-cancel small')?.checkVisibility()");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.jobs-table').parentElement.scrollWidth <= document.querySelector('.jobs-table').parentElement.clientWidth && document.querySelector('.jobs-table td[data-label=Outcome] button').disabled"), "Mobile jobs require sideways scrolling or enable an ungranted cancellation");
  const jobHeaders = (await send("Accessibility.getFullAXTree", {}, sessionId)).nodes.filter(n => !n.ignored && n.role?.value === "columnheader").map(n => String(n.name?.value || "").trim().replace(/\s+/g, " ").toLowerCase());
  for(const label of ["Action","Host","State","Created","Outcome"]) assert.ok(jobHeaders.includes(label.toLowerCase()), `Mobile jobs lost its accessible ${label} header; accessible headers: ${JSON.stringify(jobHeaders)}`);
  pass("mobile job rows expose labeled targets, state and outcome controls without overflow and preserve accessibility-tree headers");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.path.endsWith('/cancel')).length"), 0);
  await evaluate("history.back()");
  await wait("location.hash === '#/hosts/private-host' && !!document.querySelector('.service-requests')");
  pass("host and global job lists withhold cancellation when the effective host grant is missing");
  await evaluate("window.fixture.hostPermissions = null");
  await wait("!document.querySelector('.service-requests button:nth-child(2)').disabled");
  pass("effective host permissions disable unavailable requests and explain the restriction without attempting a mutation");
  await evaluate("window.fixture.hosts[0].name = 'ADMIN-ONLY-HOST'; window.fixture.canary.mappings = [{hostId:'private-host',sourceId:'fixture-source',monitorId:'unobserved'}]");
  await wait("document.querySelector('h1')?.textContent === 'ADMIN-ONLY-HOST' && document.querySelector('.host-mapping-form input[value=\"fixture-source/unobserved\"]').checked");
  await click("← All hosts");
  await wait("!!document.querySelector('.fleet-table')");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  pass("mobile navigation, short-viewport sign-out, Escape, heading focus and exact-time tap work without horizontal overflow");

  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 390, deviceScaleFactor: 1, mobile: false }, sessionId);
  assert.ok(await evaluate(`(() => {
    const button = [...document.querySelectorAll('.sidebar button')].find(b => b.textContent === 'Sign out');
    button.focus(); const r = button.getBoundingClientRect();
    return r.bottom <= innerHeight && r.top >= 0 && document.elementFromPoint(r.x + r.width/2, r.y + r.height/2) === button;
  })()`), "Short desktop sidebar makes sign-out unreachable");
  assert.ok(await evaluate("document.querySelector('.sidebar .compact-navigation select').checkVisibility() && document.querySelector('.sidebar .compact-navigation select').options.length === 6"), "Short desktop navigation hides destinations");
  await setValue(".sidebar .compact-navigation select", "activity");
  await wait("location.hash === '#/activity' && document.activeElement === document.querySelector('h1')");
  await setValue(".sidebar .compact-navigation select", "fleet");
  await wait("location.hash === '#/fleet' && document.activeElement === document.querySelector('h1')");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await evaluate("document.querySelector('.sidebar').scrollTop = 0");
  pass("short-height native workspace pickers expose all sections alongside account controls");

  await click("ADMIN-ONLY-HOST");
  await wait("location.hash === '#/hosts/private-host'");
  await wait("[...document.querySelectorAll('.page-heading button')].some(b => b.textContent === 'Run diagnostic' && !b.disabled)");
  await click("Run diagnostic");
  await wait("location.hash === '#/jobs/fixture-job-3' && document.querySelector('dialog h2')?.innerText.includes('Diagnostic')");
  assert.ok(await evaluate("document.querySelector('.job-target').innerText.includes('system.summary') && document.querySelector('.job-target').innerText.includes('ADMIN-ONLY-HOST')"), "Diagnostic receipt lost its exact job or target");
  await click("ADMIN-ONLY-HOST");
  await wait("document.querySelector('.host-actions button')?.disabled === false && !document.querySelector('dialog[open]')");
  const rebootAuthBefore = await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && r.path === '/api/auth/recent').length");
  await evaluate("document.querySelector('.host-actions').open = true");
  await click("Reboot host");
  await wait("!!document.querySelector('dialog input[name=confirm]')");
  await setValue("dialog input[name=confirm]", "wrong-fixture-id");
  await setValue("dialog input[name=password]", "temporary fixture password");
  await setValue("dialog input[name=code]", "123456");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await wait("document.querySelector('dialog [role=alert]')?.innerText.includes('Host ID does not match')");
  assert.equal(await evaluate("window.fixture.jobs.length"), 3, "Incorrect host confirmation queued a reboot");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && r.path === '/api/auth/recent').length"), rebootAuthBefore, "Incorrect host confirmation reached authentication");
  await setValue("dialog input[name=confirm]", "private-host");
  await evaluate("document.querySelector('dialog form').requestSubmit()");
  await wait("location.hash === '#/jobs/fixture-job-4' && document.querySelector('dialog h2')?.innerText.includes('Host reboot')");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && r.path === '/api/auth/recent').length"), rebootAuthBefore + 1, "Reboot submission skipped a fresh identity verification");
  assert.deepEqual(await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && ['/api/auth/recent','/api/hosts/private-host/jobs'].includes(r.path)).slice(-2).map(r => r.path)"), ["/api/auth/recent", "/api/hosts/private-host/jobs"], "Reboot job was submitted before identity verification");
  assert.ok(await evaluate("document.querySelector('.job-target').innerText.includes('ADMIN-ONLY-HOST') && document.querySelector('dialog').innerText.includes('New boot observed')"), "Reboot continuation lost target or independent boot-observation context");
  await click("ADMIN-ONLY-HOST");
  await wait("!!document.querySelector('.service-requests') && !document.querySelector('dialog[open]')");
  await click("← All hosts");
  await wait("location.hash === '#/fleet'");
  pass("diagnostic and authenticated reboot submissions open their exact job outcomes and retain typed-host confirmation");

  await click("Remote jobs");
  await wait("!!document.querySelector('.jobs-table')");
  const jobColumns = await evaluate("[...document.querySelectorAll('.jobs-table thead th')].map(c => c.getBoundingClientRect().width)");
  await evaluate("window.fixture.failWrites.add('POST /api/jobs/fixture-job-1/cancel')");
  await click("Cancel");
  await wait("document.querySelector('.job-cancel [role=alert]')?.innerText.includes('Fixture save unavailable')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.jobs-table thead th')].map(c => c.getBoundingClientRect().width)"), jobColumns, "Cancellation errors move desktop job columns");
  assert.ok(await evaluate("document.querySelector('.job-cancel button').disabled === false && window.fixture.jobs[0].cancelRequested !== true"), "Failed cancellation loses retry or claims acceptance");
  await evaluate("window.fixture.failWrites.clear(); window.fixture.hold.add('POST /api/jobs/fixture-job-1/cancel')");
  await click("Cancel");
  await wait("typeof window.fixture.holds['POST /api/jobs/fixture-job-1/cancel'] === 'function' && document.querySelector('.job-cancel-feedback').getAttribute('aria-busy') === 'true'");
  const cancellationPosts = await evaluate("window.fixture.requests.filter(r => r.path.endsWith('/cancel')).length");
  await evaluate("document.querySelector('.job-cancel button').click(); document.querySelector('.job-cancel button').click()");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.path.endsWith('/cancel')).length"), cancellationPosts, "Pending cancellation sends duplicate requests");
  assert.ok(await evaluate("document.querySelector('.job-cancel button').disabled && document.querySelector('.job-cancel [role=status]').innerText.includes('Sending cancellation')"), "Pending cancellation lacks local disabled/progress feedback");
  await evaluate("window.fixture.holds['POST /api/jobs/fixture-job-1/cancel']()");
  await wait("document.querySelector('.job-cancel [role=status]')?.innerText.includes('Cancelled before dispatch')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.jobs-table thead th')].map(c => c.getBoundingClientRect().width)"), jobColumns, "Cancellation receipt moves desktop job columns");
  await click("Fleet overview");
  await click("ADMIN-ONLY-HOST");
  await wait("!!document.querySelector('#host-jobs') && document.querySelectorAll('#host-jobs tbody tr').length === 4");
  await click("Jobs");
  await wait("!!document.activeElement.closest('#host-jobs')");
  await click("Cancel");
  await wait("document.querySelector('#host-jobs .job-cancel [role=status]')?.innerText.includes('Cancelled before dispatch')");
  pass("host and global cancellation show local pending/error/acceptance, preserve retry and prevent repeated submission");
  await evaluate("window.fixture.audit = [{id:1,at:Date.now(),actor:'fixture-actor-full-identifier-123456',hostId:'private-host',jobId:'fixture-job-1',action:'logs.read',state:'cancellation_requested'},{id:2,at:Date.now(),actor:'fixture-admin',hostId:'',jobId:'',action:'grants.replace',state:'completed'}]");
  await click("Activity & audit");
  await wait("document.querySelectorAll('.activity-event').length === 2");
  assert.ok(await evaluate("document.querySelector('.timeline').innerText.includes('Account permissions replaced') && document.querySelector('.timeline a[href=\"#/hosts/private-host\"]')?.textContent === 'ADMIN-ONLY-HOST' && !!document.querySelector('.timeline a[href=\"#/jobs/fixture-job-1\"]')"), "Activity loses readable action labels or exact host/job destinations");
  await evaluate("document.querySelector('.activity-identifiers').open = true");
  assert.ok(await evaluate("document.querySelector('.activity-identifiers').innerText.includes('fixture-actor-full-identifier-123456') && document.querySelector('.activity-identifiers').innerText.includes('fixture-job-1') && document.querySelector('.activity-identifiers').innerText.includes('private-host')"), "Activity exact identities cannot be recovered");
  await setValue("input[name=activitySearch]", "fixture-actor-full");
  await wait("document.querySelectorAll('.activity-event').length === 1");
  await setValue("select[name=activityAction]", "grants.replace");
  await wait("document.querySelector('.activity-panel').innerText.includes('No matching events within the latest 500')");
  await setValue("select[name=activityAction]", "logs.read");
  await wait("document.querySelectorAll('.activity-event').length === 1");
  await click("View job outcome");
  await wait("location.hash === '#/jobs/fixture-job-1' && !!document.querySelector('dialog[open] .job-target')");
  await click("×");
  await wait("location.hash === '#/activity' && document.querySelector('input[name=activitySearch]')?.value === 'fixture-actor-full' && document.querySelector('select[name=activityAction]').value === 'logs.read' && document.querySelectorAll('.activity-event').length === 1");
  await click("Clear activity filters");
  await wait("document.querySelectorAll('.activity-event').length === 2");
  pass("activity combines bounded search/action filters, distinguishes no matches and restores context after an outcome");
  await send("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);
  await wait("!document.querySelector('.activity-filter-disclosure').open && document.querySelector('.activity-event')?.getBoundingClientRect().top < innerHeight");
  await evaluate("document.querySelector('.activity-filter-disclosure > summary').focus()");
  // Include Enter's generated text to exercise native disclosure activation.
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r",unmodifiedText:"\r"},sessionId);
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13},sessionId);
  await wait("document.querySelector('input[name=activitySearch]').checkVisibility()");
  await setValue("input[name=activitySearch]","fixture-actor-full");
  await wait("document.querySelectorAll('.activity-event').length === 1");
  await evaluate("document.querySelector('.activity-filter-disclosure > summary').click()");
  assert.ok(await evaluate("document.querySelector('.activity-applied').checkVisibility() && document.querySelector('.activity-applied').innerText.includes('fixture-actor-full') && !document.querySelector('input[name=activitySearch]').checkVisibility()"),"Collapsed activity filters hide their applied state");
  await click("Clear activity filters");
  await wait("document.querySelectorAll('.activity-event').length === 2");
  await evaluate("document.querySelector('.activity-identifiers').open = false; document.querySelector('.activity-identifiers > summary').focus()");
  await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Enter",code:"Enter",windowsVirtualKeyCode:13,text:"\r",unmodifiedText:"\r"},sessionId);
  await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Enter",code:"Enter",windowsVirtualKeyCode:13},sessionId);
  await wait("document.querySelector('.activity-identifiers').open && document.querySelector('.activity-identifiers').innerText.includes('fixture-actor-full-identifier-123456')");
  await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  pass("mobile activity filters preserve a clear applied summary and keyboard access to filters and full identifiers");
  await click("Fleet overview");
  await wait("!!document.querySelector('.fleet-table')");
  pass("populated activity names actions, links readable hosts and exact jobs, and exposes complete identifiers");

  for (const mode of ['light', 'dark']) {
    const ratios = await evaluate(`(() => {
      document.documentElement.dataset.mode = ${JSON.stringify(mode)};
      const el = document.querySelector('.fleet-table .chip.good');
      const rgb = c => c.match(/[\\d.]+/g).map(Number);
      const base = rgb(getComputedStyle(document.querySelector('.panel')).backgroundColor);
      const bg = rgb(getComputedStyle(el).backgroundColor), fg = rgb(getComputedStyle(el).color);
      const blend = bg.slice(0, 3).map((v, i) => v * (bg[3] ?? 1) + base[i] * (1 - (bg[3] ?? 1)));
      const l = c => c.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i], 0);
      const ratio = (a,b) => (Math.max(l(a),l(b)) + .05) / (Math.min(l(a),l(b)) + .05);
      const input = getComputedStyle(document.querySelector('input.search'));
      return {status: ratio(fg,blend), control: ratio(rgb(input.borderTopColor),rgb(input.backgroundColor))};
    })()`);
    assert.ok(ratios.status >= 4.5, `Good status text contrast is below 4.5:1 in ${mode}: ${ratios.status}`);
    assert.ok(ratios.control >= 3, `Enabled control border contrast is below 3:1 in ${mode}: ${ratios.control}`);
  }
  await evaluate("document.documentElement.dataset.mode = 'light'");
  pass("actual light/dark status text meets 4.5:1 and enabled input boundaries meet 3:1 contrast");

  await evaluate("window.fixture.failSources.add('/api/audit'); window.fixture.hosts[0].latest.cpuPercent = 37");
  await wait("[...document.querySelectorAll('[role=alert]')].some(a => a.innerText.includes('Activity unavailable')) && document.querySelector('.fleet-table').innerText.includes('37.0%')");
  assert.ok(await evaluate("[...document.querySelectorAll('.fleet-table td[data-label=\"Reading freshness\"] .chip')].every(c => c.textContent.toLowerCase().includes('fresh')) && [...document.querySelectorAll('.metrics .metric')].find(m => m.innerText.includes('Canary sources')).innerText.includes('1 / 1')"), "Audit failure invalidated valid host or Canary evidence");
  await evaluate("window.fixture.failSources.clear(); window.fixture.failSources.add('/api/canary')");
  await wait("[...document.querySelectorAll('[role=alert]')].some(a => a.innerText.includes('Canary unavailable')) && ![...document.querySelectorAll('[role=alert]')].some(a => a.innerText.includes('Activity unavailable'))");
  assert.ok(await evaluate("[...document.querySelectorAll('.fleet-table td[data-label=\"Reading freshness\"] .chip')].every(c => c.textContent.toLowerCase().includes('fresh')) && document.querySelector('.fleet-table').innerText.includes('37.0%') && [...document.querySelectorAll('.metrics .metric')].find(m => m.innerText.includes('Canary sources')).innerText.includes('0 / 1')"), "Canary failure invalidated valid host readings or retained a fresh Canary source");
  await evaluate("window.fixture.failSources.clear(); window.fixture.hosts[0].latest.cpuPercent = 12");
  await wait("!document.querySelector('[role=alert]') && document.querySelector('.fleet-table').innerText.includes('12.0%')");
  await evaluate("window.fixture.hold.add('/api/audit')");
  await wait("typeof window.fixture.holds['/api/audit'] === 'function'");
  await evaluate("window.fixture.hosts[0].latest.cpuPercent = 55");
  await wait("document.querySelector('.fleet-table').innerText.includes('55.0%')");
  await evaluate("window.fixture.holds['/api/audit'](); window.fixture.hosts[0].latest.cpuPercent = 12");
  await wait("document.querySelector('.fleet-table').innerText.includes('12.0%')");
  pass("dashboard sources keep updating through isolated failures and a held audit request, invalidating only failed evidence");
  await evaluate("window.fixture.hold.add('/api/hosts'); window.fixture.hold.add('/api/canary')");
  await wait("typeof window.fixture.holds['/api/hosts'] === 'function' && typeof window.fixture.holds['/api/canary'] === 'function'");
  await ageUntil("[...document.querySelectorAll('.fleet-table td[data-label=\"Reading freshness\"] .chip')].every(c => c.textContent.toLowerCase().includes('stale')) && [...document.querySelectorAll('.fleet-table td[data-label=\"Agent connection\"] .chip')].every(c => c.textContent.toLowerCase().includes('offline')) && [...document.querySelectorAll('.metric')].find(m => m.innerText.includes('Canary sources')).innerText.includes('0 / 1') && document.querySelectorAll('.usage.stale').length === 6 && !document.querySelector('.source-warning')", 120000);
  await evaluate("window.dispatchEvent(new Event('focus')); window.fixture.holds['/api/hosts'](); window.fixture.holds['/api/canary']()");
  await wait("document.querySelectorAll('.usage.stale').length === 0");
  pass("host and Canary evidence age locally on resume while source requests remain pending");
  await click("Access & accounts");
  await wait("document.querySelector('[role=alert]')?.innerText.includes('Fixture account list unavailable') && !!document.querySelector('select[name=user]')");
  assert.equal(await evaluate("document.querySelector('select[name=user]').checkValidity()"), false, "Empty account select allows grant submission");
  await evaluate(`(() => { const form = document.querySelector('select[name=user]').closest('form'); form.querySelector('input[name=scope]').value = 'private-host'; form.requestSubmit(); })()`);
  assert.equal(await evaluate("window.fixture.grantWrites"), 0, "Empty account selection sent a grant write");
  await capture("04-account-list-error");
  await evaluate("document.querySelector('[aria-label=\"Dismiss error\"]')?.click()");
  pass("failed account loading reports an error and blocks empty grant submission");
  await click("Uptime Canary");
  await wait("document.querySelector('tbody')?.innerText.includes('Unobserved fixture monitor') && document.querySelector('tbody').innerText.includes('Unknown')");
  await capture("01-null-observations");
  pass("null Canary observations render an unknown row without crashing");

  await click("Fleet overview");
  await click("ADMIN-ONLY-HOST");
  await wait("document.body.innerText.includes('ADMIN-ONLY-PROCESS')");
  await evaluate("window.fixture.hosts[0].latest.cpuPercent = null; window.fixture.hosts[0].resourceHealth = 'unknown'; window.fixture.offline = true");
  await wait("!!document.querySelector('[role=alert]') && document.querySelectorAll('.metrics .chip.good').length === 0 && [...document.querySelectorAll('.metrics .chip')].some(c => c.textContent.toLowerCase().includes('stale'))");
  assert.ok(await evaluate("document.querySelector('.reading-snapshot')?.innerText.includes('retained snapshot') && document.querySelectorAll('.retained-label').length === 4 && [...document.querySelectorAll('th')].some(h => h.textContent === 'Last known state') && document.body.innerText.includes('Last known service snapshot')"), "Stale host readings or service states are presented without retained qualification");
  // The prior response may still contain CPU 12; a separate fresh null snapshot is checked below after recovery.
  await capture("02-disconnected-dashboard");
  await evaluate("window.fixture.offline = false; window.fixture.htmlFailure = true");
  await wait("document.querySelector('[role=alert]')?.innerText.includes('Request failed (502)')");
  await click("Uptime Canary");
  await wait("[...document.querySelectorAll('h2')].some(h => h.textContent.includes('fixture-source') && h.textContent.toLowerCase().includes('stale')) && document.querySelectorAll('.chip.good').length === 0");
  pass("failed polling invalidates cached host and Canary health");

  await evaluate("window.fixture.htmlFailure = false; window.fixture.offline = false");
  await click("Fleet overview");
  // Source recovery removes a banner and changes row positions. Navigate only
  // after the successful null-CPU response has reached the fleet.
  await wait("location.hash === '#/fleet' && !document.querySelector('.source-warning') && document.querySelector('.fleet-table tbody tr:first-child td[data-label=Resources]')?.innerText.includes('Unknown')");
  await click("ADMIN-ONLY-HOST");
  await wait("document.querySelector('.host-resources')?.innerText.includes('Not measured')");
  assert.ok(await evaluate("!document.querySelector('.host-resources').innerText.includes('Sampling')"), "Missing CPU implies active sampling");
  await evaluate("window.fixture.hosts[0].latest.cpuPercent = 12; window.fixture.hosts[0].resourceHealth = 'normal'");
  pass("a missing CPU value is not presented as an active sampling operation");

  // Projects: empty inventory, administrator registration and metadata conflicts.
  await click("Projects");
  await wait("document.body.innerText.includes('No projects yet') && !document.querySelector('table')");
  await capture("05-projects-empty");
  await click("Register a project");
  await setValue("input[name=projectId]", "fixture-project");
  await setValue("input[name=projectName]", "Fixture project");
  await setValue("textarea[name=projectDescription]", "Temporary browser fixture");
  await evaluate(`document.querySelector('form[aria-label="Register a project"] input[value=dependencies]').click()`);
  await evaluate("window.fixture.failSources.add('/api/projects/fixture-project/audit')");
  await submit("Register a project");
  await wait(`document.querySelector('h1')?.textContent.includes('Fixture project') && !!document.querySelector('form[aria-label="Project details"]')`);
  await evaluate("document.querySelector('.project-settings > summary').click()");
  assert.ok(await evaluate("document.querySelector('input[name=editName]').getClientRects().length"), "Metadata edits are hidden from the user");
  await wait("document.querySelector('.project-history [role=alert]')?.textContent.includes('History could not be refreshed') && document.querySelector('.repository-identity h3')?.textContent.includes('Connect a GitHub repository')");
  assert.ok(await evaluate("!document.querySelector('input[name=editName]').disabled"), "Project history failure disabled valid project controls");
  await evaluate("window.fixture.failSources.clear()");
  await evaluate("window.fixture.events['fixture-project'][0].actor = 'fixture-project-actor-full-identifier-123456'");
  assert.deepEqual(await evaluate("window.fixture.projects['fixture-project'].modules"), ["dependencies"]);
  pass("empty project inventory allows administrator registration with explicit modules");

  await setValue("input[name=editName]", "Fixture project renamed");
  await evaluate("window.fixture.confirmCount = 0; window.confirm = () => { window.fixture.confirmCount++; return false; }");
  await click("Fleet overview");
  assert.equal(await evaluate("location.hash"), "#/projects/fixture-project", "Navigation discarded an unsaved metadata draft");
  await evaluate("history.back()");
  await wait("window.fixture.confirmCount >= 2 && location.hash === '#/projects/fixture-project'");
  assert.equal(await evaluate("document.querySelector('input[name=editName]').value"), "Fixture project renamed", "Declining Back discarded unsaved metadata");
  await send("Emulation.setDeviceMetricsOverride", { width:1440,height:390,deviceScaleFactor:1,mobile:false }, sessionId);
  await setValue(".sidebar .compact-navigation select", "fleet");
  assert.ok(await evaluate("location.hash === '#/projects/fixture-project' && document.querySelector('.sidebar .compact-navigation select').value === 'projects' && document.querySelector('input[name=editName]').value === 'Fixture project renamed'"), "Native short-height navigation discards a protected project draft");
  await send("Emulation.setDeviceMetricsOverride", { width:1440,height:1000,deviceScaleFactor:1,mobile:false }, sessionId);
  await evaluate("window.confirm = () => true");
  pass("unsaved project edits survive declined workspace navigation and browser Back");
  await evaluate("window.fixture.recent = false");
  await submit("Project details");
  await wait("document.querySelector('.project-edit-feedback [role=alert]')?.innerText.includes('Verify identity') && document.querySelector('input[name=editName]').value === 'Fixture project renamed'");
  await evaluate("window.fixture.recent = true");
  await evaluate("window.fixture.externalEdit('fixture-project')");
  await submit("Project details");
  await wait("document.querySelector('.notice.conflict')?.innerText.includes('saved by someone else') && document.querySelector('input[name=editName]').value === 'Fixture project renamed'");
  assert.equal(await evaluate("window.fixture.projects['fixture-project'].name"), "Fixture project", "Stale metadata save overwrote a newer revision");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save project details').disabled"), true, "Save stays enabled during an unresolved conflict");
  await capture("06-project-conflict");
  await click("Keep my edits on revision");
  await evaluate("window.fixture.hold.add('PUT /api/projects/fixture-project')");
  await submit("Project details");
  await wait("typeof window.fixture.holds['PUT /api/projects/fixture-project'] === 'function'");
  assert.ok(await evaluate("document.querySelector('input[name=editName]').disabled && document.querySelector('textarea[name=editDescription]').disabled && document.querySelector('input[value=dependencies]').matches(':disabled')"), "Project controls remain editable during a pending save");
  await evaluate("window.fixture.holds['PUT /api/projects/fixture-project']()");
  await wait("window.fixture.projects['fixture-project'].name === 'Fixture project renamed' && window.fixture.projects['fixture-project'].revision === 3 && document.querySelector('h1').textContent.includes('renamed')");
  pass("stale metadata saves reload as a conflict, keep unsaved input and save only after explicit resolution");
  pass("pending project saves lock fields and feature choices until the submitted revision completes");
  await wait("[...document.querySelectorAll('.project-actor code')].some(c => c.textContent === 'fixture-project-actor-full-identifier-123456')");
  await evaluate("[...document.querySelectorAll('.project-actor')].find(d => d.textContent.includes('fixture-project-actor-full-identifier-123456')).open = true");
  assert.ok(await evaluate("[...document.querySelectorAll('.project-actor code')].some(c => c.checkVisibility() && c.textContent === 'fixture-project-actor-full-identifier-123456')"), "Project history does not expose the full actor identity");
  pass("project history discloses complete actor identities without losing attribution");

  // GitHub source: a recent-authentication failure keeps input; success clears the token everywhere.
  await wait(`document.querySelector('.repository-identity h3')?.innerText.includes('Connect a GitHub repository') && !!document.querySelector('form[aria-label="GitHub source settings"] fieldset:not([disabled])') && document.querySelector('input[name=repository]').getClientRects().length > 0`);
  await evaluate("window.fixture.recent = false");
  await setValue("input[name=repository]", "fixture-owner/fixture-repo");
  await setValue("input[data-secret=github-token]", token);
  await submit("GitHub source settings");
  await wait(`[...document.querySelectorAll('.settings [role=alert]')].some(a => a.innerText.includes('recent password and MFA') && a.innerText.includes('Verify identity')) && document.querySelector('input[data-secret=github-token]').value === ${JSON.stringify(token)}`);
  assert.equal(await evaluate("window.fixture.githubPuts.length"), 0);
  await evaluate("window.fixture.recent = true");
  await submit("GitHub source settings");
  await wait("window.fixture.githubPuts.length === 1 && document.querySelector('input[data-secret=github-token]').value === '' && document.body.innerText.includes('Saved source revision 1')");
  assert.ok(await evaluate("[...document.querySelectorAll('.settings [role=status]')].some(s => s.innerText.includes('Saved source revision 1'))"), "Repository save success is outside its status region");
  assert.deepEqual(await evaluate("window.fixture.githubPuts[0]"), { repository: "fixture-owner/fixture-repo", enabled: true, revision: 0, tokenLength: token.length });
  assert.equal(await evaluate(`(() => { const t = ${JSON.stringify(token)}; const stores = [localStorage, sessionStorage].flatMap(s => Object.keys(s).map(k => k + s.getItem(k))); return window.fixture.requests.some(r => (r.path + r.search).includes(t)) || stores.some(v => v.includes(t)) || document.documentElement.outerHTML.includes(t) || location.href.includes(t); })()`), false, "GitHub token leaked into a URL, storage or the document");
  pass("GitHub setup is recent-MFA gated, keeps input on failure and clears the token without URL or storage exposure");

  await evaluate("window.fixture.githubViews['fixture-project'] = window.fixture.freshView('fixture-owner/fixture-repo')");
  await wait(`${goodChips} >= 3 && document.body.innerText.includes('Bump fixture-lib') && document.body.innerText.includes('Dependency update PRs') && !document.body.innerText.includes('Retained observation')`);
  await capture("07-github-fresh");
  await ageUntil("document.querySelector('.github-heading').innerText.includes('Collection: stale') && document.querySelector('.github .notice.retained')?.innerText.includes('older than 30 minutes') && document.querySelectorAll('.github .chip.good').length === 0", 31 * 60000);
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await wait("document.querySelector('.github-heading').innerText.includes('Collection: fresh')");
  pass("GitHub collection freshness and positive result tones expire locally after the 30-minute evidence window");
  await evaluate("window.fixture.githubFail = true");
  await wait(`document.body.innerText.includes('Polling failed') && ${goodChips} === 0`);
  pass("a failed GitHub poll invalidates previously healthy observations");
  await evaluate("window.fixture.githubFail = false; window.fixture.githubViews['fixture-project'] = window.fixture.retainedView('fixture-owner/fixture-repo')");
  await wait(`document.body.innerText.includes('Retained observation') && document.body.innerText.includes('Workflow runs could not be read') && document.body.innerText.includes('Truncated') && document.body.innerText.includes('not a package-version inventory') && !document.body.innerText.includes('Polling failed') && ${goodChips} === 0`);
  assert.equal(await evaluate("[...document.querySelectorAll('.github .metric')].find(m => m.innerText.includes('Dependabot alerts')).innerText.includes('1+')"), true, "Truncated alerts rendered as a complete count");
  await capture("08-github-retained");
  await evaluate("window.fixture.hold.add('POST /api/projects/fixture-project/github/sync')");
  await click("Request refresh");
  await wait("typeof window.fixture.holds['POST /api/projects/fixture-project/github/sync'] === 'function' && [...document.querySelectorAll('.github button')].some(b => b.textContent === 'Requesting refresh…' && b.disabled && b.getAttribute('aria-busy') === 'true')");
  await evaluate("[...document.querySelectorAll('.github button')].find(b => b.textContent === 'Requesting refresh…').click()");
  assert.equal(await evaluate("window.fixture.requests.filter(r => r.method === 'POST' && r.path.endsWith('/github/sync')).length"), 1, "Pending GitHub refresh submitted a repeat request");
  await evaluate("window.fixture.holds['POST /api/projects/fixture-project/github/sync']()");
  await wait("document.body.innerText.includes('Refresh is cooling down')");
  pass("GitHub refresh shows pending feedback and rejects repeated submission before a response");
  assert.ok(await evaluate("[...document.querySelectorAll('.github-feedback [role=status]')].some(s => s.innerText.includes('Refresh is cooling down'))"), "Refresh feedback is outside its status region");
  assert.ok(await evaluate("window.fixture.requests.some(r => r.method === 'POST' && r.path === '/api/projects/fixture-project/github/sync')"));
  pass("retained, partial, unreadable and truncated GitHub data stay explicit; refresh cooldown is reported");

  // A late response for a previously opened project cannot populate another project.
  await evaluate("window.fixture.seedProject('alpha-project', 'ALPHA-ONLY-PROJECT', ['dependencies']); window.fixture.githubViews['alpha-project'] = window.fixture.freshView('alpha-owner/ALPHA-ONLY-REPO'); window.fixture.hold.add('/api/projects/alpha-project/github')");
  await click("← All projects");
  await wait("document.body.innerText.includes('ALPHA-ONLY-PROJECT')");
  await click("ALPHA-ONLY-PROJECT");
  await wait("typeof window.fixture.holds['/api/projects/alpha-project/github'] === 'function'");
  await click("← All projects");
  await wait("document.body.innerText.includes('Fixture project renamed')");
  await click("Fixture project renamed");
  await wait("document.querySelector('h1')?.textContent.includes('Fixture project renamed') && document.body.innerText.includes('fixture-owner/fixture-repo')");
  await evaluate("window.fixture.holds['/api/projects/alpha-project/github']()");
  await sleep(300);
  assert.equal(await evaluate("document.body.innerText.includes('ALPHA-ONLY')"), false, "A late response leaked another project's data");
  pass("project detail and GitHub responses are scoped to their project mount");

  // Grants: load before editing, ignore late responses for another account, block on load failure, preserve host + project grants.
  await evaluate("window.fixture.usersFail = false");
  await click("Fleet overview");
  await click("Access & accounts");
  await wait("[...document.querySelectorAll('select[name=user] option')].some(o => o.value === 'operator-fixture')");
  await evaluate("window.fixture.hold.add('/api/users/operator-fixture/grants')");
  await setValue("select[name=user]", "operator-fixture");
  await wait("typeof window.fixture.holds['/api/users/operator-fixture/grants'] === 'function'");
  await setValue("select[name=user]", "viewer-fixture");
  await wait(`!!document.querySelector('[data-grant="host:viewer-host:host.read"]')`);
  await evaluate("window.fixture.holds['/api/users/operator-fixture/grants']()");
  await sleep(300);
  assert.equal(await evaluate(`!!document.querySelector('[data-grant="project:fixture-project:project.read"]')`), false, "A late grant response replaced the selected account's grants");
  await setValue("select[name=user]", "unreadable-fixture");
  await wait("[...document.querySelectorAll('[role=alert]')].some(a => a.innerText.includes('Current grants could not be loaded')) && [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Replace grants').disabled");
  await setValue("select[name=user]", "operator-fixture");
  await wait(`!!document.querySelector('[data-grant="host:viewer-host:host.read"]') && !!document.querySelector('[data-grant="project:fixture-project:project.read"]')`);
  assert.ok(await evaluate("document.querySelector('.check-grid input[value=\"host.manage\"]').disabled && document.querySelector('.permission-limit')?.innerText.includes('Administrator only')"), "Operator grant editor offers ineffective inventory editing");
  await evaluate("document.querySelector('.check-grid input[value=\"host.manage\"]').click()");
  assert.equal(await evaluate("document.querySelector('.check-grid input[value=\"host.manage\"]').checked"), false, "Disabled administrator-only grant was selected");
  pass("operator grant choices explain and withhold administrator-only inventory editing");
  await setValue("select[name=scopeType]", "project");
  await setValue("select[name=projectScope]", "fixture-project");
  await evaluate(`document.querySelector('.check-grid input[value="github.read"]').click()`);
  await click("Add to working set");
  await wait(`!!document.querySelector('[data-grant="project:fixture-project:github.read"]')`);
  assert.ok(await evaluate("document.querySelector('.grant-change-review').innerText.includes('Adding (1)') && document.querySelector('.grant-change-review').innerText.includes('View repository observations') && document.querySelector('.grant-change-review').innerText.includes('Project ID:') && document.querySelector('.grant-change-review').innerText.includes('fixture-project') && document.querySelector('.grant-change-review').innerText.includes('Removing (0)')"), "Grant replacement lacks explicit changes or an unambiguous project target");
  await evaluate("window.confirm = () => true");
  await evaluate("window.fixture.hold.add('PUT /api/users/operator-fixture/grants')");
  await click("Replace grants");
  await wait("typeof window.fixture.holds['PUT /api/users/operator-fixture/grants'] === 'function'");
  assert.ok(await evaluate("document.querySelector('select[name=user]').disabled && [...document.querySelectorAll('[data-grant] button')].every(b => b.disabled)"), "Pending grant replacement permits account switching or removal");
  await click("Remove");
  assert.equal(await evaluate("document.querySelectorAll('[data-grant]').length"), 3, "Disabled grant removal changed the submitted working set");
  await evaluate("window.fixture.hold.add('GET /api/users/operator-fixture/grants'); window.fixture.holds['PUT /api/users/operator-fixture/grants']()");
  await wait("typeof window.fixture.holds['GET /api/users/operator-fixture/grants'] === 'function'");
  assert.ok(await evaluate("document.querySelector('select[name=user]').disabled"), "Account switching unlocked before complete-set reload finished");
  await evaluate("window.fixture.holds['GET /api/users/operator-fixture/grants']()");
  await wait("!!window.fixture.lastGrantPut");
  await wait("[...document.querySelectorAll('.grant-editor [role=status]')].some(s => s.innerText.includes('Grants replaced for operator-fixture'))");
  const written = await evaluate("window.fixture.lastGrantPut");
  assert.equal(written.user, "operator-fixture");
  assert.deepEqual(written.grants.map((g) => `${g.scopeType}:${g.scope}:${g.action}`).sort(),
    ["host:viewer-host:host.read", "project:fixture-project:github.read", "project:fixture-project:project.read"], "Grant replacement dropped an existing host or project grant");
  await capture("09-grant-editor");
  pass("grant editing loads the complete set first, preserves host and project grants and ignores stale account responses");
  pass("grant replacement locks account and removal controls through submission and complete-set reload");
  await setValue("select[name=scopeType]","host");
  await setValue("select[name=grantTarget]","viewer-host");
  await evaluate("document.querySelector('.check-grid input[value=\"logs.read\"]').click()");
  await click("Add to working set");
  await evaluate("document.querySelector('[data-grant=\"project:fixture-project:project.read\"] button').click(); window.fixture.grantStore['operator-fixture'] = window.fixture.grantStore['operator-fixture'].filter(g => g.action !== 'host.read').concat({scopeType:'host',scope:'private-host',action:'diagnostic'}); window.fixture.failWrites.add('GET /api/users/operator-fixture/grants')");
  await click("Replace grants");
  await wait("!!document.querySelector('.grant-conflict [role=alert]') && !!document.querySelector('[data-grant=\"host:viewer-host:logs.read\"]')");
  assert.ok(await evaluate("document.querySelector('[data-grant=\"host:viewer-host:host.read\"]') && !document.querySelector('[data-grant=\"project:fixture-project:project.read\"]') && [...document.querySelectorAll('.grant-editor button')].find(b => b.textContent === 'Replace grants').disabled"),"A grant conflict discarded the draft or permits stale replacement");
  await evaluate("window.fixture.failWrites.clear()");
  await click("Retry latest grants");
  await wait("document.querySelector('.grant-conflict').innerText.includes('Reapply my changes for review')");
  const grantAttempts = await evaluate("window.fixture.grantWrites");
  await click("Reapply my changes for review");
  await wait("!document.querySelector('.grant-conflict') && !!document.querySelector('[data-grant=\"host:private-host:diagnostic\"]')");
  assert.equal(await evaluate("window.fixture.grantWrites"),grantAttempts,"Grant reconciliation saved without review");
  assert.ok(await evaluate("!document.querySelector('[data-grant=\"host:viewer-host:host.read\"]') && !document.querySelector('[data-grant=\"project:fixture-project:project.read\"]') && !!document.querySelector('[data-grant=\"host:viewer-host:logs.read\"]') && !!document.querySelector('[data-grant=\"project:fixture-project:github.read\"]')"),"Reconciliation restored revoked access or lost independent edits");
  await click("Replace grants");
  await wait("window.fixture.grantWrites === " + (grantAttempts + 1) + " && !document.querySelector('select[name=user]').disabled && document.querySelector('.grant-save').innerText.includes('No unsaved changes')");
  assert.deepEqual((await evaluate("window.fixture.lastGrantPut.grants")).map(g => `${g.scopeType}:${g.scope}:${g.action}`).sort(),["host:private-host:diagnostic","host:viewer-host:logs.read","project:fixture-project:github.read"],"Reconciled save changed a concurrent grant");
  pass("grant conflicts retain drafts through failed latest reads and reapply only intended edits without restoring concurrent revocations");
  await click("Create account");
  await wait("document.querySelector('.account-create').open && document.activeElement?.name === 'name'");
  await setValue(".account-create input[name=name]", "temporary-account");
  await setValue(".account-create input[name=password]", "temporary fixture password");
  await evaluate("window.fixture.recent = false; document.querySelector('form[aria-label=\"Create an account\"]').requestSubmit()");
  await wait("document.querySelector('.account-create [role=alert]')?.innerText.includes('Verify identity') && document.querySelector('.account-create input[name=password]').value === 'temporary fixture password'");
  await evaluate("window.fixture.recent = true; document.querySelector('form[aria-label=\"Create an account\"]').requestSubmit()");
  await wait("window.fixture.createdUsers.length === 1 && document.querySelector('.account-create .notice .secret')?.textContent === 'FIXTURE-ONLY-AUTHENTICATOR-SECRET' && document.querySelector('.account-create input[name=password]').value === '' && document.querySelector('.account-create form button').textContent === 'Create account'");
  assert.ok(await evaluate("document.querySelector('.account-create').innerText.includes('Authenticator setup for temporary-account') && document.querySelector('.account-create form button').disabled"), "One-time authenticator setup lacks account context or can be overwritten");
  assert.equal(await evaluate("(() => {const secret = 'FIXTURE-ONLY-AUTHENTICATOR-SECRET'; return [localStorage,sessionStorage].some(s => Object.keys(s).some(k => (k+s.getItem(k)).includes(secret))) || location.href.includes(secret);})()"), false, "Authenticator setup leaked into storage or a URL");
  await evaluate("window.confirm = () => false");
  await click("Fleet overview");
  assert.equal(await evaluate("location.hash"), "#/access", "Navigation silently discarded one-time authenticator setup");
  await click("Dismiss secret");
  await evaluate("window.confirm = () => true");
  pass("account setup keeps failed input local, clears successful passwords and protects named one-time secrets without storage");
  await click("Fleet overview");
  await click("ADMIN-ONLY-HOST");
  await wait("document.querySelectorAll('.metrics .chip.good').length >= 3");
  await evaluate("window.fixture.holdHosts = true");
  await wait("typeof window.fixture.releaseHosts === 'function'");
  await evaluate("window.fixture.logoutFailure = 503");
  await click("Sign out");
  await wait("document.querySelector('[role=alert]')?.innerText.includes('Fixture sign-out unavailable')");
  assert.equal(await evaluate("document.body.innerText.includes('ADMIN-ONLY-PROCESS')"), true, "Unknown remote logout was silently presented as complete");
  await evaluate("window.fixture.logoutFailure = 0");
  await click("Sign out");
  await wait("!!document.querySelector('input[name=code]')");
  await evaluate(`(() => { for (const [name, value] of Object.entries({name:'viewer-fixture',password:'fixture password',code:'123456'})) document.querySelector('input[name='+name+']').value = value; document.querySelector('form').requestSubmit(); })()`);
  await wait("document.body.innerText.includes('Viewer fixture host') && document.body.innerText.includes('viewer-fixture')");
  await evaluate("window.fixture.releaseHosts()");
  await evaluate("new Promise(done => setTimeout(done, 200))");
  assert.equal(await evaluate("document.body.innerText.includes('ADMIN-ONLY')"), false, "Previous account data survived logout or a late response");
  assert.equal(await evaluate("document.querySelector('h1').textContent.trim()"), "Fleet overview", "Previous account view survived logout");
  await capture("03-restricted-viewer");
  pass("account changes clear private detail/view state and ignore a late old-account response");
  await click("Projects");
  await wait("document.body.innerText.includes('Fixture project renamed') && !document.body.innerText.includes('ALPHA-ONLY') && !document.body.innerText.includes('Register a project')");
  await click("Fixture project renamed");
  await wait("!!document.querySelector('.project-settings > summary')");
  await evaluate("document.querySelector('.project-settings > summary').click()");
  await wait("document.body.innerText.includes('GitHub read permission required') && document.body.innerText.includes('Read only') && !document.querySelector('form[aria-label=\"Project details\"]')");
  assert.equal(await evaluate("window.fixture.requests.some(r => r.role === 'viewer' && r.path.endsWith('/github'))"), false, "GitHub data requested without github.read");
  assert.equal(await evaluate("document.body.innerText.includes('fixture-owner/fixture-repo')"), false, "Previous account's GitHub data visible to viewer");
  pass("viewer project access honors capabilities: no registration, editing or GitHub reads without github.read");
  await evaluate("window.fixture.logoutFailure = 401");
  await click("Sign out");
  await wait("!!document.querySelector('input[name=code]') && !document.body.innerText.includes('Viewer fixture host')");
  pass("expired session sign-out returns to authentication; unconfirmed server failures remain visible");
  }
  assert.deepEqual(errors, [], "Uncaught browser exceptions");
  writeFileSync(join(evidence, "results.json"), JSON.stringify({ status: "passed", browser: version.product, screenshots, cases, refreshDelays: visual ? "Five-second refresh delays accelerated to one second for synthetic captures only" : "Production timers" }, null, 2));
  console.log(`${visual ? "UI capture" : "Browser fixture proof"}: ${version.product}; ${cases} regression cases; ${screenshots.length} bounded screenshots`);
} finally {
  await send("Browser.close").catch(() => {});
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
}
