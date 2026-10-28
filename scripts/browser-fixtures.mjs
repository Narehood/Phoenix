// Linux CI only. Exercise the built dashboard with fresh, bounded API fixtures.
// No Phoenix server, retained identity, real host or external service is used.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

assert.equal(process.platform, "linux", "Browser fixtures require Linux CI");
assert.ok(process.env.PHOENIX_OUTPUT, "Run through scripts/validate.py");
const scratch = process.env.PHOENIX_OUTPUT;
const web = join(scratch, "web");
const evidence = resolve(".validation/browser-evidence");
mkdirSync(web);
mkdirSync(evidence, { recursive: true });
const container = execFileSync("docker", ["create", "phoenix:ci"], { encoding: "utf8", timeout: 10000 }).trim();
assert.match(container, /^[a-f0-9]{64}$/);
try {
  execFileSync("docker", ["cp", `${container}:/usr/share/phoenix/web/.`, web], { timeout: 10000 });
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
    uptimeSeconds: 3600, bootId: "fixture-boot", services: [], collectionErrors: [],
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
  const emptyCanary = { sources: [], mappings: [], now };
  const canary = {
    now, mappings: [{ hostId: privateHost.id, sourceId: "fixture-source", monitorId: "unobserved" }],
    sources: [{ id: "fixture-source", node: { id: "fixture-node", name: "Fixture node" },
      revision: "fixture", collectedAt: now, measuredAt: now, freshness: "fresh", error: "",
      maintenance: [], monitors: [{ monitor: { id: "unobserved", name: "Unobserved fixture monitor", intervalMs: 30000, nodeIds: [] },
        state: "unknown", observations: null, maintenanceIds: [], unknownNodes: 1, configConflict: false }] }],
  };
  const control = window.fixture = { role: "admin", offline: false, htmlFailure: false, logoutFailure: 0, grantWrites: 0, holdHosts: false, releaseHosts: null };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (input) => {
    const path = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
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
    if (path === "/api/session") return json({ user: user(control.role), csrfToken: "fixture-csrf" });
    if (path === "/api/users") return json({ error: "Fixture account list unavailable" }, 503);
    if (/^\/api\/users\/.*\/grants$/.test(path)) { control.grantWrites++; return json({ error: "Unexpected fixture grant write" }, 400); }
    if (path === "/api/hosts") {
      const snapshot = { hosts: admin ? [privateHost, viewerHost] : [viewerHost] };
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
      if (await evaluate(expression)) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Browser assertion timed out: ${expression}`);
  };
  const click = (text) => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!button) throw Error('Missing fixture button'); button.click(); })()`);
  const screenshots = [];
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
  await click("Access & accounts");
  await wait("document.querySelector('[role=alert]')?.innerText.includes('Fixture account list unavailable') && !!document.querySelector('select[name=user]')");
  assert.equal(await evaluate("document.querySelector('select[name=user]').checkValidity()"), false, "Empty account select allows grant submission");
  await evaluate(`(() => { const form = document.querySelector('select[name=user]').closest('form'); form.querySelector('input[name=scope]').value = 'private-host'; form.requestSubmit(); })()`);
  assert.equal(await evaluate("window.fixture.grantWrites"), 0, "Empty account selection sent a grant write");
  await capture("04-account-list-error");
  await evaluate("document.querySelector('[aria-label=\"Dismiss error\"]')?.click()");
  console.log("PASS failed account loading reports an error and blocks empty grant submission");
  await click("Uptime Canary");
  await wait("document.querySelector('tbody')?.innerText.includes('Unobserved fixture monitor') && document.querySelector('tbody').innerText.includes('Unknown')");
  await capture("01-null-observations");
  console.log("PASS null Canary observations render an unknown row without crashing");

  await click("Fleet overview");
  await click("ADMIN-ONLY-HOST");
  await wait("document.body.innerText.includes('ADMIN-ONLY-PROCESS')");
  await evaluate("window.fixture.offline = true");
  await wait("!!document.querySelector('[role=alert]') && document.querySelectorAll('.metrics .chip.good').length === 0 && [...document.querySelectorAll('.metrics .chip')].some(c => c.textContent.includes('stale'))");
  await capture("02-disconnected-dashboard");
  await evaluate("window.fixture.offline = false; window.fixture.htmlFailure = true");
  await wait("document.querySelector('[role=alert]')?.innerText.includes('Request failed (502)')");
  await click("Uptime Canary");
  await wait("[...document.querySelectorAll('h2')].some(h => h.textContent.includes('fixture-source') && h.textContent.includes('stale')) && document.querySelectorAll('.chip.good').length === 0");
  console.log("PASS failed polling invalidates cached host and Canary health");

  await evaluate("window.fixture.htmlFailure = false; window.fixture.offline = false");
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
  console.log("PASS account changes clear private detail/view state and ignore a late old-account response");
  await evaluate("window.fixture.logoutFailure = 401");
  await click("Sign out");
  await wait("!!document.querySelector('input[name=code]') && !document.body.innerText.includes('Viewer fixture host')");
  console.log("PASS expired session sign-out returns to authentication; unconfirmed server failures remain visible");
  assert.deepEqual(errors, [], "Uncaught browser exceptions");
  writeFileSync(join(evidence, "results.json"), JSON.stringify({ status: "passed", browser: version.product, screenshots, cases: 4 }, null, 2));
  console.log(`Browser fixture proof: ${version.product}; four bounded screenshots`);
} finally {
  await send("Browser.close").catch(() => {});
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
}
