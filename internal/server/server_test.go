package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Narehood/Phoenix/internal/core"
	"github.com/Narehood/Phoenix/internal/security"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

type fixture struct {
	clockMu     sync.RWMutex
	t           *testing.T
	s           *Server
	web, agents *httptest.Server
	browser     *http.Client
	csrf        string
	user        core.User
	now         time.Time
	secret      string
}
type testAgent struct {
	id              string
	client          *http.Client
	invitation, csr string
	identity        core.Identity
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	c := Config{DataDir: filepath.Join(dir, "data"), IdentityDir: filepath.Join(dir, "identity"), Origin: "https://localhost", WebDir: filepath.Join(dir, "web")}
	tokenPath, e := Init(c)
	if e != nil {
		t.Fatal(e)
	}
	s, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	f := &fixture{t: t, s: s, now: time.Now()}
	s.Now = func() time.Time { f.clockMu.RLock(); defer f.clockMu.RUnlock(); return f.now }
	cert, e := tls.LoadX509KeyPair(filepath.Join(c.IdentityDir, "server.pem"), filepath.Join(c.IdentityDir, "server.key"))
	if e != nil {
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	roots.AddCert(s.CA.Certificate)
	f.web = httptest.NewUnstartedServer(s.WebHandler())
	f.web.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}}
	f.web.StartTLS()
	s.Config.Origin = f.web.URL
	f.agents = httptest.NewUnstartedServer(s.AgentHandler())
	f.agents.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots, SessionTicketsDisabled: true}
	f.agents.Config.ConnContext = func(ctx context.Context, c net.Conn) context.Context {
		s.mu.Lock()
		s.connections[c] = ""
		s.mu.Unlock()
		return context.WithValue(ctx, connKey{}, c)
	}
	f.agents.Config.ConnState = func(c net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			s.mu.Lock()
			delete(s.connections, c)
			s.mu.Unlock()
		}
	}
	f.agents.StartTLS()
	jar, _ := cookiejar.New(nil)
	tc, e := security.ClientTLS(s.CA.PEM, "")
	if e != nil {
		t.Fatal(e)
	}
	f.browser = &http.Client{Transport: &http.Transport{TLSClientConfig: tc}, Jar: jar, Timeout: 5 * time.Second}
	t.Cleanup(func() { f.browser.CloseIdleConnections(); f.web.Close(); f.agents.Close(); s.DB.Close() })
	token, e := os.ReadFile(tokenPath)
	if e != nil {
		t.Fatal(e)
	}
	var begin struct {
		Secret string `json:"secret"`
	}
	f.call("POST", "/api/auth/setup/begin", map[string]string{"token": string(token), "name": "fixture-admin", "password": "fixture password long enough"}, 200, &begin)
	f.secret = begin.Secret
	code, e := totp.GenerateCode(begin.Secret, f.now)
	if e != nil {
		t.Fatal(e)
	}
	var auth struct {
		User core.User `json:"user"`
		CSRF string    `json:"csrfToken"`
	}
	f.call("POST", "/api/auth/setup/finish", map[string]string{"token": string(token), "code": code}, 201, &auth)
	f.csrf = auth.CSRF
	f.user = auth.User
	return f
}
func (f *fixture) call(method, path string, body any, status int, out any) {
	f.t.Helper()
	f.request(f.browser, f.web.URL, method, path, body, status, out, f.csrf)
}
func (f *fixture) request(client *http.Client, origin, method, path string, body any, status int, out any, csrf string) {
	f.t.Helper()
	var b io.Reader
	if body != nil {
		b = strings.NewReader(core.Encode(body))
	}
	req, e := http.NewRequest(method, origin+path, b)
	if e != nil {
		f.t.Fatal(e)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", f.web.URL)
	req.Header.Set("X-CSRF-Token", csrf)
	response, e := client.Do(req)
	if e != nil {
		f.t.Fatal(e)
	}
	defer response.Body.Close()
	data, e := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if e != nil {
		f.t.Fatal(e)
	}
	if response.StatusCode != status {
		var public map[string]string
		_ = json.Unmarshal(data, &public)
		f.t.Fatalf("%s %s status %d, want %d; public error %q", method, path, response.StatusCode, status, public["error"])
	}
	if out != nil {
		if e = json.Unmarshal(data, out); e != nil {
			f.t.Fatal(e)
		}
	}
}
func (f *fixture) newAgent(name string) *testAgent {
	f.t.Helper()
	var invite struct {
		HostID     string `json:"hostId"`
		Invitation string `json:"invitation"`
	}
	f.call("POST", "/api/invitations", map[string]any{"name": name, "groups": []string{"lab"}}, 201, &invite)
	csr, key, e := security.NewCSR()
	if e != nil {
		f.t.Fatal(e)
	}
	var id core.Identity
	f.call("POST", "/enroll", core.Enrollment{Invitation: invite.Invitation, CSR: csr, OS: "linux", OSVersion: "Debian fixture", Addresses: []string{"192.0.2.10"}, AgentVersion: core.Version}, 201, &id)
	if id.HostID != invite.HostID {
		f.t.Fatal("host binding mismatch")
	}
	f.call("POST", "/api/hosts/"+id.HostID+"/jobs", map[string]any{"action": "diagnostic", "args": core.Args{Diagnostic: "system.summary"}}, 409, nil)
	block, _ := pem.Decode([]byte(id.Certificate))
	if block == nil {
		f.t.Fatal("invalid certificate")
	}
	f.call("POST", "/api/hosts/"+id.HostID+"/approve", map[string]string{"confirm": id.HostID, "certificateFingerprint": security.HashBytes(block.Bytes)}, 200, nil)
	return &testAgent{id: id.HostID, client: f.agentClient(id, string(key)), identity: id, invitation: invite.Invitation, csr: csr}
}
func (f *fixture) agentClient(id core.Identity, key string) *http.Client {
	tc, e := security.ClientTLS(f.s.CA.PEM, "")
	if e != nil {
		f.t.Fatal(e)
	}
	cert, e := tls.X509KeyPair([]byte(id.Certificate), []byte(key))
	if e != nil {
		f.t.Fatal(e)
	}
	tc.Certificates = []tls.Certificate{cert}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: tc}, Timeout: 5 * time.Second}
	f.t.Cleanup(client.CloseIdleConnections)
	return client
}
func (f *fixture) exchange(a *testAgent, reading *core.Reading, receipts []core.Receipt, running string) core.Delivery {
	f.t.Helper()
	var d core.Delivery
	f.request(a.client, f.agents.URL, "POST", "/agent/exchange", core.Exchange{Protocol: core.Protocol, AgentVersion: core.Version, Reading: reading, Receipts: receipts, RunningJob: running}, 200, &d, "")
	return d
}
func (f *fixture) reading(stale bool, boot string) *core.Reading {
	at := f.now.UnixMilli()
	if stale {
		at -= 120000
	}
	cpu := 12.5
	return &core.Reading{MeasuredAt: at, BootID: boot, CPUPercent: &cpu, MemoryUsed: 256, MemoryTotal: 1024, DiskUsed: 512, DiskTotal: 4096, UptimeSeconds: 7200, Processes: []core.Process{{PID: 42, Name: "fixture", MemoryBytes: 4096}}, Services: []core.Service{{Name: "fixture.service", Load: "loaded", Active: "active", Sub: "running"}}, CollectionErrors: []string{}}
}
func (f *fixture) job(a *testAgent, action string, args core.Args) core.Job {
	f.t.Helper()
	var j core.Job
	f.call("POST", "/api/hosts/"+a.id+"/jobs", map[string]any{"action": action, "args": args, "confirm": a.id}, 201, &j)
	return j
}

func TestFiveIndependentAgentsAndEnrollment(t *testing.T) {
	f := newFixture(t)
	agents := []*testAgent{}
	fingerprints := map[string]bool{}
	for _, name := range []string{"Debian one", "Debian two", "Debian three", "Stale Debian", "Offline Debian"} {
		a := f.newAgent(name)
		agents = append(agents, a)
		hash := security.Hash(a.identity.Certificate)
		if fingerprints[hash] {
			t.Fatal("reused certificate")
		}
		fingerprints[hash] = true
	}
	f.advance(time.Minute)
	for i := 0; i < 4; i++ {
		f.exchange(agents[i], f.reading(i == 3, "boot-a"), nil, "")
	}
	var inventory struct {
		Hosts []core.Host `json:"hosts"`
	}
	f.call("GET", "/api/hosts", nil, 200, &inventory)
	if len(inventory.Hosts) != 5 {
		t.Fatal("expected five hosts")
	}
	states := map[string]core.Host{}
	for _, h := range inventory.Hosts {
		states[h.Name] = h
	}
	if states["Offline Debian"].Connectivity != "offline" || states["Offline Debian"].Freshness != "unknown" {
		t.Fatal("offline identity was treated as down or fresh")
	}
	if states["Stale Debian"].Freshness != "stale" || states["Stale Debian"].ResourceHealth != "unknown" {
		t.Fatal("stale telemetry was treated as healthy")
	}
	f.call("POST", "/enroll", core.Enrollment{Invitation: agents[0].invitation, CSR: agents[0].csr, OS: "linux"}, 403, nil)
	f.call("POST", "/api/invitations", map[string]any{"name": "Impersonation", "reenrollHost": agents[0].id, "confirm": agents[0].id}, 409, nil)
}

func TestJobsInterruptedDeliveryRestartAndReboot(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Debian")
	f.exchange(a, f.reading(false, "boot-before"), nil, "")
	j := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	d := f.exchange(a, nil, nil, "")
	if d.Job == nil || d.Job.ID != j.ID {
		t.Fatal("missing dispatch")
	}
	if f.exchange(a, nil, nil, "").Job != nil {
		t.Fatal("duplicate delivery after interruption")
	}
	f.s.sweep()
	if _, e := f.s.DB.Exec(`UPDATE jobs SET state='uncertain' WHERE id=?`, j.ID); e != nil {
		t.Fatal(e)
	}
	result := core.Result{State: "succeeded", Stdout: "fixture output", ExitCode: 0, StartedAt: f.now.UnixMilli(), FinishedAt: f.now.UnixMilli()}
	receipt := []core.Receipt{{ID: j.ID, Result: result}}
	if len(f.exchange(a, nil, receipt, "").Acknowledged) != 1 {
		t.Fatal("receipt not acknowledged")
	}
	f.exchange(a, nil, receipt, "")
	var count int
	if e := f.s.DB.QueryRow(`SELECT COUNT(*) FROM audit WHERE job_id=? AND state='succeeded'`, j.ID).Scan(&count); e != nil || count != 1 {
		t.Fatal("duplicate receipt changed audit")
	}
	reboot := f.job(a, "host.reboot", core.Args{})
	f.exchange(a, nil, nil, "")
	f.exchange(a, nil, []core.Receipt{{ID: reboot.ID, Result: core.Result{State: "accepted", StartedAt: f.now.UnixMilli(), FinishedAt: f.now.UnixMilli()}}}, "")
	var got core.Job
	f.call("GET", "/api/jobs/"+reboot.ID, nil, 200, &got)
	if got.State != "accepted" || got.RebootObserved {
		t.Fatal("acceptance incorrectly proves reboot")
	}
	f.advance(31 * time.Second)
	f.exchange(a, f.reading(false, "boot-after"), nil, "")
	f.call("GET", "/api/jobs/"+reboot.ID, nil, 200, &got)
	if !got.RebootObserved {
		t.Fatal("new boot was not reconciled")
	}
	// Create a dispatched job, then instantiate the real startup recovery path.
	restart := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.exchange(a, nil, nil, "")
	reopened, e := New(f.s.Config)
	if e != nil {
		t.Fatal(e)
	}
	defer reopened.DB.Close()
	var state string
	if e = reopened.DB.QueryRow(`SELECT state FROM jobs WHERE id=?`, restart.ID).Scan(&state); e != nil || state != "uncertain" {
		t.Fatal("server restart requeued a dispatched action")
	}
	if e = reopened.DB.QueryRow(`SELECT COUNT(*) FROM audit WHERE job_id=? AND state='uncertain:server_restart'`, restart.ID).Scan(&count); e != nil || count != 1 {
		t.Fatal("restart uncertainty not audited")
	}
}

func TestRevocationRotationAndWrongCertificates(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Rotate")
	f.exchange(a, nil, nil, "")
	csr, key, e := security.NewCSR()
	if e != nil {
		t.Fatal(e)
	}
	var identity core.Identity
	f.request(a.client, f.agents.URL, "POST", "/agent/renew", map[string]string{"csr": csr}, 200, &identity, "")
	f.request(a.client, f.agents.URL, "POST", "/agent/exchange", core.Exchange{Protocol: 1}, 401, nil, "")
	a.client = f.agentClient(identity, string(key))
	f.exchange(a, nil, nil, "")
	f.call("POST", "/api/hosts/"+a.id+"/revoke", map[string]string{"confirm": a.id}, 200, nil)
	f.request(a.client, f.agents.URL, "POST", "/agent/exchange", core.Exchange{Protocol: 1}, 401, nil, "")
	f.call("POST", "/api/hosts/"+a.id+"/jobs", map[string]any{"action": "diagnostic", "args": core.Args{Diagnostic: "system.summary"}}, 409, nil)
	wrong, e := security.NewCA()
	if e != nil {
		t.Fatal(e)
	}
	csr, key, e = security.NewCSR()
	if e != nil {
		t.Fatal(e)
	}
	cert, _, _, e := wrong.Sign(csr, a.id, time.Hour)
	if e != nil {
		t.Fatal(e)
	}
	client := f.agentClient(core.Identity{Certificate: cert}, string(key))
	response, e := client.Post(f.agents.URL+"/agent/exchange", "application/json", strings.NewReader(`{"protocol":1}`))
	if response != nil {
		response.Body.Close()
	}
	if e == nil {
		t.Fatal("untrusted client certificate accepted")
	}
	f.call("POST", "/api/invitations", map[string]any{"name": "Rotate", "reenrollHost": a.id, "confirm": a.id}, 201, nil)
}

func TestAuthorizationCSRFRecentAuthAndOutput(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Scoped")
	b := f.newAgent("Other")
	f.request(f.browser, f.web.URL, "POST", "/api/hosts/"+a.id+"/jobs", map[string]any{"action": "diagnostic", "args": core.Args{Diagnostic: "system.summary"}}, 403, nil, "wrong")
	req, _ := http.NewRequest("POST", f.web.URL+"/api/invitations", bytes.NewBufferString(`{"name":"CSRF"}`))
	req.Header.Set("Origin", "https://attacker.invalid")
	req.Header.Set("X-CSRF-Token", f.csrf)
	response, e := f.browser.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("cross-origin mutation accepted")
	}
	var account struct {
		User   core.User `json:"user"`
		Secret string    `json:"secret"`
	}
	f.call("POST", "/api/users", map[string]string{"name": "operator", "role": "operator", "password": "another fixture password"}, 201, &account)
	f.call("PUT", "/api/users/"+account.User.ID+"/grants", map[string]any{"grants": []core.Grant{{ScopeType: "host", Scope: a.id, Action: "host.read"}, {ScopeType: "host", Scope: a.id, Action: "diagnostic"}}}, 200, nil)
	jar, _ := cookiejar.New(nil)
	operator := &http.Client{Transport: f.browser.Transport, Jar: jar, Timeout: 5 * time.Second}
	code, _ := totp.GenerateCode(account.Secret, f.now)
	var auth struct {
		CSRF string `json:"csrfToken"`
	}
	f.request(operator, f.web.URL, "POST", "/api/auth/login", map[string]string{"name": "operator", "password": "another fixture password", "code": code}, 200, &auth, "")
	f.request(operator, f.web.URL, "GET", "/api/hosts/"+b.id, nil, 403, nil, "")
	f.request(operator, f.web.URL, "POST", "/api/hosts/"+a.id+"/jobs", map[string]any{"action": "service.restart", "args": core.Args{Service: "fixture.service"}, "confirm": a.id}, 403, nil, auth.CSRF)
	j := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.exchange(a, nil, nil, "")
	f.exchange(a, nil, []core.Receipt{{ID: j.ID, Result: core.Result{State: "succeeded", Stdout: "secret command output"}}}, "")
	var got core.Job
	f.request(operator, f.web.URL, "GET", "/api/jobs/"+j.ID, nil, 200, &got, "")
	if got.Result != nil {
		t.Fatal("output leaked without grant")
	}
	f.advance(6 * time.Minute)
	f.call("POST", "/api/hosts/"+a.id+"/jobs", map[string]any{"action": "host.reboot", "args": core.Args{}, "confirm": a.id}, 403, nil)
	f.call("POST", "/api/hosts/"+a.id+"/jobs", map[string]any{"action": "diagnostic", "args": core.Args{Diagnostic: "sh -c evil"}}, 400, nil)
}

func TestExpiredJobsCancellationAndDispatchReauthorization(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Queue")
	j := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.advance(6 * time.Minute)
	if f.exchange(a, nil, nil, "").Job != nil {
		t.Fatal("expired command executed on reconnect")
	}
	var state string
	_ = f.s.DB.QueryRow(`SELECT state FROM jobs WHERE id=?`, j.ID).Scan(&state)
	if state != "expired" {
		t.Fatal("missing expiry state")
	}
	j = f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.call("POST", "/api/jobs/"+j.ID+"/cancel", map[string]any{}, 200, nil)
	if f.exchange(a, nil, nil, "").Job != nil {
		t.Fatal("cancelled job dispatched")
	}
	j = f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	if _, e := f.s.DB.Exec(`DELETE FROM grants WHERE user_id=?`, f.user.ID); e != nil {
		t.Fatal(e)
	}
	if f.exchange(a, nil, nil, "").Job != nil {
		t.Fatal("dispatch ignored removed grants")
	}
	_ = f.s.DB.QueryRow(`SELECT state FROM jobs WHERE id=?`, j.ID).Scan(&state)
	if state != "denied" {
		t.Fatal("missing dispatch denial")
	}
}

func TestAuthenticationThrottleAndSessionRevocation(t *testing.T) {
	f := newFixture(t)
	f.call("POST", "/api/auth/revoke-sessions", map[string]any{}, 200, nil)
	f.call("GET", "/api/session", nil, 401, nil)
	for i := 0; i < 8; i++ {
		f.call("POST", "/api/auth/login", map[string]string{"name": "absent", "password": "wrong", "code": "000000"}, 401, nil)
	}
	f.call("POST", "/api/auth/login", map[string]string{"name": "absent", "password": "wrong", "code": "000000"}, 429, nil)
}

func TestOverlappingRequestCannotRestoreRevokedSession(t *testing.T) {
	for _, action := range []string{"logout", "revoke-sessions", "disable"} {
		t.Run(action, func(t *testing.T) {
			f := newFixture(t)
			path := "/api/auth/" + action
			var disabledID string
			if action == "disable" {
				var account struct {
					User core.User `json:"user"`
				}
				f.call("POST", "/api/users", map[string]string{"name": "disable-fixture", "role": "viewer", "password": "disable fixture password"}, 201, &account)
				disabledID = account.User.ID
				path = "/api/users/" + disabledID + "/disable"
			}
			origin, e := url.Parse(f.web.URL)
			if e != nil {
				t.Fatal(e)
			}
			var cookie *http.Cookie
			for _, c := range f.browser.Jar.Cookies(origin) {
				if c.Name == "__Host-phoenix" {
					cookie = c
				}
			}
			if cookie == nil {
				t.Fatal("fixture session cookie missing")
			}
			// Model a request that loaded the old cookie before revocation and
			// reaches the idle-timeout commit only after revocation completes.
			pending, e := f.s.Sessions.Load(context.Background(), cookie.Value)
			if e != nil || f.s.Sessions.GetString(pending, "user") != f.user.ID {
				t.Fatal("overlapping request did not load the authenticated session")
			}
			var result map[string]bool
			f.call("POST", path, map[string]any{}, 200, &result)
			if action == "disable" {
				var active bool
				if e = f.s.DB.QueryRow(`SELECT active FROM users WHERE id=?`, disabledID).Scan(&active); e != nil || active || !result["disabled"] {
					t.Fatal("account disable did not complete successfully")
				}
			}
			for _, current := range f.browser.Jar.Cookies(origin) {
				if current.Name == cookie.Name {
					t.Fatal("revocation did not clear the browser session cookie")
				}
			}
			if _, _, e = f.s.Sessions.Commit(pending); e == nil {
				t.Fatal("stale request restored a revoked session")
			}
			cookie.Path, cookie.Secure = "/", true
			f.browser.Jar.SetCookies(origin, []*http.Cookie{cookie})
			f.call("GET", "/api/session", nil, 401, nil)
		})
	}
}

func TestExpiryAndRunningCancellation(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Deadline")
	j := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.exchange(a, nil, nil, "")
	f.call("POST", "/api/jobs/"+j.ID+"/cancel", map[string]any{}, 200, nil)
	if !f.exchange(a, nil, nil, j.ID).Cancel {
		t.Fatal("running cancellation not delivered")
	}
	f.advance(25 * time.Hour)
	f.request(a.client, f.agents.URL, "POST", "/agent/exchange", core.Exchange{Protocol: 1}, 401, nil, "")
}

func (f *fixture) advance(d time.Duration) {
	f.clockMu.Lock()
	f.now = f.now.Add(d)
	f.clockMu.Unlock()
}

func TestConfirmedRestartDispatchAndRecentAuthentication(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Restart fixture")
	body := map[string]any{"action": "service.restart", "args": core.Args{Service: "fixture.service"}}
	f.call("POST", "/api/hosts/"+a.id+"/jobs", body, 400, nil)
	j := f.job(a, "service.restart", core.Args{Service: "fixture.service"})
	d := f.exchange(a, nil, nil, "")
	if d.Job == nil || d.Job.ID != j.ID || d.Job.Action != "service.restart" || d.Job.Args.Service != "fixture.service" {
		t.Fatal("approved restart was not dispatched with its exact typed target")
	}
	f.exchange(a, nil, []core.Receipt{{ID: j.ID, Result: core.Result{State: "succeeded", Stdout: "safe restart fixture", ExitCode: 0}}}, "")
	var got core.Job
	f.call("GET", "/api/jobs/"+j.ID, nil, 200, &got)
	if got.State != "succeeded" || got.Result == nil || got.Result.ExitCode != 0 {
		t.Fatal("restart fixture outcome was not persisted")
	}
	f.advance(6 * time.Minute)
	body["confirm"] = a.id
	f.call("POST", "/api/hosts/"+a.id+"/jobs", body, 403, nil)
}

func TestPrunedReceiptDoesNotBlockAgentExchange(t *testing.T) {
	f := newFixture(t)
	a := f.newAgent("Receipt retention fixture")
	old := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.exchange(a, nil, nil, "")
	result := core.Result{State: "succeeded", ExitCode: 0}
	f.exchange(a, nil, []core.Receipt{{ID: old.ID, Result: result}}, "")
	// The agent missed the acknowledgement; only the disposable server record
	// is removed, modeling normal job retention before its next reconnect.
	if _, err := f.s.DB.Exec(`DELETE FROM jobs WHERE id=?`, old.ID); err != nil {
		t.Fatal(err)
	}
	next := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.advance(time.Second)
	d := f.exchange(a, f.reading(false, "retention-boot"), []core.Receipt{{ID: old.ID, Result: result}}, "")
	if len(d.Acknowledged) != 1 || d.Acknowledged[0] != old.ID || d.Job == nil || d.Job.ID != next.ID {
		t.Fatal("pruned receipt blocked acknowledgement or subsequent dispatch")
	}
	h, err := f.s.host(a.id)
	if err != nil || h.Latest == nil || h.LastContact != f.now.UnixMilli() {
		t.Fatal("pruned receipt rolled back telemetry")
	}
	var count int
	if err = f.s.DB.QueryRow(`SELECT COUNT(*) FROM audit WHERE job_id=? AND action='receipt.unmatched' AND state='ignored'`, old.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("unmatched receipt was not audited")
	}
	never := f.job(a, "diagnostic", core.Args{Diagnostic: "system.summary"})
	f.request(a.client, f.agents.URL, "POST", "/agent/exchange", core.Exchange{Protocol: core.Protocol, Receipts: []core.Receipt{{ID: never.ID, Result: result}}}, 409, nil, "")
	for _, receipt := range []core.Receipt{{ID: "missing", Result: core.Result{State: "invalid"}}, {ID: strings.Repeat("x", 65), Result: result}} {
		f.request(a.client, f.agents.URL, "POST", "/agent/exchange", core.Exchange{Protocol: core.Protocol, Receipts: []core.Receipt{receipt}}, 400, nil, "")
	}
}

func TestHistoryAndAuthenticationRateBudgetsAreSeparate(t *testing.T) {
	s := &Server{throttle: map[string]*attempt{}, Now: time.Now}
	for i := 0; i < 10; i++ {
		if !s.rateKey("history:fixture-user") {
			t.Fatal("history budget rejected early")
		}
	}
	if s.rateKey("history:fixture-user") {
		t.Fatal("history budget is not bounded")
	}
	r := httptest.NewRequest("POST", "https://example.invalid/api/auth/login", nil)
	if !s.rate(r) {
		t.Fatal("history reads consumed the authentication budget")
	}
	if cost, err := bcrypt.Cost([]byte(dummyPasswordHash)); err != nil || cost != 12 {
		t.Fatal("invalid-user bcrypt work does not match the account password cost")
	}
}
