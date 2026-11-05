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

function installFixture() {
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
    usersFail: true, recent: true, authFailure: 0, githubFail: false, syncStatus: 429, projects: {}, events: {}, githubViews: {}, githubPuts: [], failSources: new Set(), createdUsers: [],
    grantStore: {
      "operator-fixture": [{ scopeType: "host", scope: "viewer-host", action: "host.read" }, { scopeType: "project", scope: "fixture-project", action: "project.read" }],
      "viewer-fixture": [{ scopeType: "host", scope: "viewer-host", action: "host.read" }],
    },
    lastGrantPut: null, shared: ["fixture-project"], requests: [], hold: new Set(), holds: {} };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const recentRequired = () => json({ error: "recent password and MFA required" }, 403);
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
    if (control.hold.delete(path)) return new Promise((done) => { control.holds[path] = () => { delete control.holds[path]; done(respond()); }; });
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
      const snapshot = { hosts: admin ? fixtureHosts : [viewerHost] };
      if (admin && control.holdHosts) {
        control.holdHosts = false;
        return new Promise((done) => { control.releaseHosts = () => { control.releaseHosts = null; done(json(snapshot)); }; });
      }
      return json(snapshot);
    }
    if (path === "/api/hosts/private-host") return admin ? json({ host: privateHost, samples: [reading] }) : json({ error: "action forbidden" }, 403);
    if (path === "/api/hosts/viewer-host") return json({ host: viewerHost, samples: [] });
    if (path === "/api/canary") return json(admin ? canary : emptyCanary);
    if (path === "/api/jobs" || path === "/api/audit") return json([]);
    return json({ error: "unexpected fixture request" }, 404);
  };
}

const server = createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const file = resolve(web, path === "/" ? "index.html" : `.${path}`);
  if (!file.startsWith(web + sep) || !existsSync(file)) { response.writeHead(404).end(); return; }
  const mime = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html";
  let body = readFileSync(file);
  if (file.endsWith("index.html")) body = Buffer.from(body.toString().replace("<head>", `<head><script>(${installFixture.toString()})();</script>`));
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
    throw new Error(`Browser assertion timed out: ${expression}`);
  };
  const click = async (text) => {
    const point = await evaluate(`(() => { const button = [...document.querySelectorAll('button,a')].find(b => !b.closest('details:not([open])') && b.checkVisibility() && b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!button) throw Error('Missing visible fixture control: ' + ${JSON.stringify(text)}); button.scrollIntoView({block:'nearest'}); const r = button.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2; if (document.elementFromPoint(x,y)?.closest('button,a') !== button) throw Error('Fixture control is obstructed: ' + ${JSON.stringify(text)}); return {x,y}; })()`);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, sessionId);
  };
  const screenshots = [];
  let cases = 0;
  const pass = (name) => { cases++; console.log(`PASS ${name}`); };
  const sleep = (ms) => evaluate(`new Promise(done => setTimeout(done, ${ms}))`);
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
  };
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.bringToFront", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` }, sessionId);
  await wait("document.body?.innerText.includes('ADMIN-ONLY-HOST')");
  if (visual) {
    await captureUI({ send, sessionId, evaluate, wait, click, capture });
  } else {
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
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await wait("!document.querySelector('.mobile-navigation').open && document.activeElement === document.querySelector('.mobile-navigation summary')");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  await evaluate("document.querySelector('.mobile-navigation summary').click()");
  await click("Fleet overview");
  await wait("!!document.querySelector('.fleet-table')");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('.fleet-table').scrollWidth <= innerWidth"), "Host statuses require horizontal document/table scrolling on mobile");
  assert.equal(await evaluate("[...document.querySelector('.fleet-table tbody tr').querySelectorAll('.chip')].filter(c => c.checkVisibility() && /fresh/i.test(c.textContent)).length"), 1, "Mobile host repeats its reading freshness status");
  await evaluate("window.fixture.hosts[0].resourceHealth = 'warning'; window.fixture.hosts[0].latest.cpuPercent = 96");
  await wait("document.querySelector('.attention-filter')?.textContent.includes('(1)') && [...document.querySelectorAll('.mobile-resource-warning .chip')].some(c => c.checkVisibility() && c.textContent.includes('Resource warning'))");
  assert.equal(await evaluate("document.querySelector('.resource-details').open"), false, "Resource-warning proof needs a collapsed card");
  await click("Agent / readings issues");
  await wait("document.querySelector('.attention-filter').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.fleet-table tbody tr').length === 1 && document.querySelector('.fleet-table').innerText.includes('ADMIN-ONLY-HOST')");
  assert.ok(await evaluate("document.querySelector('.compact-freshness').innerText.toLowerCase().includes('fresh readings')"), "Resource warning incorrectly changed independent reading freshness");
  assert.ok(await evaluate("document.querySelector('.mobile-resource-warning').innerText.includes('CPU 96.0%')"), "Resource warning hides its current measurement");
  await evaluate("window.fixture.hosts[0].resourceHealth = 'normal'; window.fixture.hosts[0].latest.cpuPercent = 12");
  await wait("document.body.innerText.includes('No matching hosts')");
  await click("Show all hosts");
  await wait("document.querySelectorAll('.fleet-table tbody tr').length === 2");
  pass("collapsed mobile cards expose resource warnings and attention filtering preserves independent freshness");
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await evaluate("document.querySelector('.sidebar').scrollTop = 0");
  pass("short desktop sidebars scroll account controls into view");

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
  await evaluate("window.fixture.offline = true");
  await wait("!!document.querySelector('[role=alert]') && document.querySelectorAll('.metrics .chip.good').length === 0 && [...document.querySelectorAll('.metrics .chip')].some(c => c.textContent.includes('stale'))");
  assert.ok(await evaluate("document.querySelector('.reading-snapshot')?.innerText.includes('retained snapshot') && document.querySelectorAll('.retained-label').length === 4 && [...document.querySelectorAll('th')].some(h => h.textContent === 'Last known state') && document.body.innerText.includes('Last known service snapshot')"), "Stale host readings or service states are presented without retained qualification");
  await capture("02-disconnected-dashboard");
  await evaluate("window.fixture.offline = false; window.fixture.htmlFailure = true");
  await wait("document.querySelector('[role=alert]')?.innerText.includes('Request failed (502)')");
  await click("Uptime Canary");
  await wait("[...document.querySelectorAll('h2')].some(h => h.textContent.includes('fixture-source') && h.textContent.includes('stale')) && document.querySelectorAll('.chip.good').length === 0");
  pass("failed polling invalidates cached host and Canary health");

  await evaluate("window.fixture.htmlFailure = false; window.fixture.offline = false");

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
  assert.deepEqual(await evaluate("window.fixture.projects['fixture-project'].modules"), ["dependencies"]);
  pass("empty project inventory allows administrator registration with explicit modules");

  await setValue("input[name=editName]", "Fixture project renamed");
  await evaluate("window.fixture.confirmCount = 0; window.confirm = () => { window.fixture.confirmCount++; return false; }");
  await click("Fleet overview");
  assert.equal(await evaluate("location.hash"), "#/projects/fixture-project", "Navigation discarded an unsaved metadata draft");
  await evaluate("history.back()");
  await wait("window.fixture.confirmCount >= 2 && location.hash === '#/projects/fixture-project'");
  assert.equal(await evaluate("document.querySelector('input[name=editName]').value"), "Fixture project renamed", "Declining Back discarded unsaved metadata");
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
  await submit("Project details");
  await wait("window.fixture.projects['fixture-project'].name === 'Fixture project renamed' && window.fixture.projects['fixture-project'].revision === 3 && document.querySelector('h1').textContent.includes('renamed')");
  pass("stale metadata saves reload as a conflict, keep unsaved input and save only after explicit resolution");

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
  await evaluate("window.fixture.githubFail = true");
  await wait(`document.body.innerText.includes('Polling failed') && ${goodChips} === 0`);
  pass("a failed GitHub poll invalidates previously healthy observations");
  await evaluate("window.fixture.githubFail = false; window.fixture.githubViews['fixture-project'] = window.fixture.retainedView('fixture-owner/fixture-repo')");
  await wait(`document.body.innerText.includes('Retained observation') && document.body.innerText.includes('Workflow runs could not be read') && document.body.innerText.includes('Truncated') && document.body.innerText.includes('not a package-version inventory') && !document.body.innerText.includes('Polling failed') && ${goodChips} === 0`);
  assert.equal(await evaluate("[...document.querySelectorAll('.github .metric')].find(m => m.innerText.includes('Dependabot alerts')).innerText.includes('1+')"), true, "Truncated alerts rendered as a complete count");
  await capture("08-github-retained");
  await click("Request refresh");
  await wait("document.body.innerText.includes('Refresh is cooling down')");
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
  await setValue("select[name=scopeType]", "project");
  await setValue("select[name=projectScope]", "fixture-project");
  await evaluate(`document.querySelector('.check-grid input[value="github.read"]').click()`);
  await click("Add to working set");
  await wait(`!!document.querySelector('[data-grant="project:fixture-project:github.read"]')`);
  await evaluate("window.confirm = () => true");
  await click("Replace grants");
  await wait("!!window.fixture.lastGrantPut");
  await wait("[...document.querySelectorAll('.grant-editor [role=status]')].some(s => s.innerText.includes('Grants replaced for operator-fixture'))");
  const written = await evaluate("window.fixture.lastGrantPut");
  assert.equal(written.user, "operator-fixture");
  assert.deepEqual(written.grants.map((g) => `${g.scopeType}:${g.scope}:${g.action}`).sort(),
    ["host:viewer-host:host.read", "project:fixture-project:github.read", "project:fixture-project:project.read"], "Grant replacement dropped an existing host or project grant");
  await capture("09-grant-editor");
  pass("grant editing loads the complete set first, preserves host and project grants and ignores stale account responses");
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
  writeFileSync(join(evidence, "results.json"), JSON.stringify({ status: "passed", browser: version.product, screenshots, cases }, null, 2));
  console.log(`${visual ? "UI capture" : "Browser fixture proof"}: ${version.product}; ${cases} regression cases; ${screenshots.length} bounded screenshots`);
} finally {
  await send("Browser.close").catch(() => {});
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
}
